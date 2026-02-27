const { filterContactProps, filterDealProps } = require('../governance/propertyAllowlist');
const { buildIdempotencyKey, withIdempotency } = require('../governance/withIdempotency');

const HUBSPOT_BASE_URL = 'https://api.hubapi.com';
const LOCKED_PIPELINE_ID = '2047365827';
const LOCKED_STAGE_ID = '3233958612';

function buildError({ message, status, code, details }) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  error.details = details;
  return error;
}

async function hubspotRequest(path, options = {}) {
  const token = process.env.HUBSPOT_ACCESS_TOKEN;
  const method = options.method || 'GET';
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    ...(options.headers || {})
  };

  const response = await fetch(`${HUBSPOT_BASE_URL}${path}`, {
    method,
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  if (!response.ok) {
    const rawError = await response.text();
    let details;

    try {
      details = JSON.parse(rawError);
    } catch {
      details = { raw: rawError };
    }

    throw buildError({
      message: 'HubSpot API request failed',
      status: response.status,
      code: details?.category || details?.error || 'hubspot_api_error',
      details
    });
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

async function findContactByPhone(phoneE164) {
  if (!phoneE164) {
    return null;
  }

  const body = {
    filterGroups: [
      {
        filters: [
          {
            propertyName: 'phone',
            operator: 'EQ',
            value: phoneE164
          }
        ]
      }
    ],
    properties: ['phone', 'firstname', 'lastname'],
    limit: 1
  };

  const result = await hubspotRequest('/crm/v3/objects/contacts/search', {
    method: 'POST',
    body
  });

  const [contact] = result?.results || [];
  if (!contact) {
    return null;
  }

  return {
    id: contact.id,
    properties: contact.properties || {}
  };
}

async function getContactById(contactId) {
  if (!contactId) {
    throw buildError({
      message: 'Contact lookup requires contactId',
      code: 'missing_contact_id'
    });
  }

  const result = await hubspotRequest(`/crm/v3/objects/contacts/${contactId}?properties=phone,sms_customer_consent,sms_customer_consent_ts`);
  return {
    id: result.id,
    properties: result.properties || {}
  };
}

async function upsertContact(contactProps, { callSid }) {
  const payload = filterContactProps(contactProps);
  const phone = payload.properties.phone;

  if (!phone) {
    throw buildError({
      message: 'Contact upsert requires allowlisted phone property',
      code: 'missing_phone'
    });
  }

  const key = buildIdempotencyKey({
    tenant: 'single',
    callSid,
    operation: 'hubspot_upsert_contact',
    inputs: {
      phone,
      propertiesWritten: payload.properties
    }
  });

  return withIdempotency({
    key,
    loggerContext: { callSid, operation: 'hubspot_upsert_contact' },
    fn: async () => {
      const existing = await findContactByPhone(phone);
      if (existing) {
        await hubspotRequest(`/crm/v3/objects/contacts/${existing.id}`, {
          method: 'PATCH',
          body: payload
        });

        return { id: existing.id };
      }

      const created = await hubspotRequest('/crm/v3/objects/contacts', {
        method: 'POST',
        body: payload
      });

      return { id: created.id };
    }
  });
}

async function createDeal({ contactId, callSid }) {
  const payload = filterDealProps({
    pipeline: LOCKED_PIPELINE_ID,
    dealstage: LOCKED_STAGE_ID,
    call_disposition: 'missed_call_captured'
  });

  const key = buildIdempotencyKey({
    tenant: 'single',
    callSid,
    operation: 'hubspot_create_deal',
    inputs: {
      contactId,
      pipelineId: LOCKED_PIPELINE_ID,
      stageId: LOCKED_STAGE_ID,
      callSid
    }
  });

  return withIdempotency({
    key,
    loggerContext: { callSid, operation: 'hubspot_create_deal' },
    fn: async () => {
      const created = await hubspotRequest('/crm/v3/objects/deals', {
        method: 'POST',
        body: payload
      });

      return { id: created.id, contactId, callSid };
    }
  });
}

async function associateDealToContact(dealId, contactId, { callSid }) {
  const key = buildIdempotencyKey({
    tenant: 'single',
    callSid,
    operation: 'hubspot_associate_deal_contact',
    inputs: {
      dealId,
      contactId
    }
  });

  return withIdempotency({
    key,
    loggerContext: { callSid, operation: 'hubspot_associate_deal_contact' },
    fn: async () => {
      await hubspotRequest(`/crm/v3/objects/deals/${dealId}/associations/contacts/${contactId}/deal_to_contact`, {
        method: 'PUT'
      });

      return { ok: true };
    }
  });
}

async function logEngagement(dealId, contactId, payload = {}) {
  const noteBody = payload.noteBody || 'Call started. TranscriptRef: pending. Summary: pending.';
  const callSid = payload.callSid;

  const key = buildIdempotencyKey({
    tenant: 'single',
    callSid,
    operation: 'hubspot_log_engagement',
    inputs: {
      dealId,
      contactId,
      callSid,
      noteText: noteBody
    }
  });

  return withIdempotency({
    key,
    loggerContext: { callSid, operation: 'hubspot_log_engagement' },
    fn: async () => {
      await hubspotRequest('/crm/v3/objects/notes', {
        method: 'POST',
        body: {
          properties: {
            hs_note_body: noteBody
          },
          associations: [
            {
              to: { id: String(dealId) },
              types: [
                {
                  associationCategory: 'HUBSPOT_DEFINED',
                  associationTypeId: 214
                }
              ]
            },
            {
              to: { id: String(contactId) },
              types: [
                {
                  associationCategory: 'HUBSPOT_DEFINED',
                  associationTypeId: 202
                }
              ]
            }
          ]
        }
      });

      return {
        ok: true,
        callSid: callSid || null
      };
    }
  });
}


async function updateDealStage({ dealId, pipelineId, dealstage, callSid }) {
  if (!dealId) {
    throw buildError({
      message: 'Deal stage update requires dealId',
      code: 'missing_deal_id'
    });
  }

  const payload = filterDealProps({
    pipeline: pipelineId,
    dealstage
  });

  const key = buildIdempotencyKey({
    tenant: 'single',
    callSid,
    operation: 'hubspot_update_deal_stage',
    inputs: {
      dealId,
      pipelineId,
      dealstage
    }
  });

  return withIdempotency({
    key,
    loggerContext: { callSid, operation: 'hubspot_update_deal_stage' },
    fn: async () => {
      await hubspotRequest(`/crm/v3/objects/deals/${dealId}`, {
        method: 'PATCH',
        body: payload
      });

      return {
        ok: true,
        dealId,
        pipelineId,
        dealstage
      };
    }
  });
}

async function updateContactConsent({ contactId, consent, consentTsISO, callSid }) {
  if (!contactId) {
    throw buildError({
      message: 'Contact consent update requires contactId',
      code: 'missing_contact_id'
    });
  }

  const payload = filterContactProps({
    sms_customer_consent: consent,
    sms_customer_consent_ts: consentTsISO
  });

  const key = buildIdempotencyKey({
    tenant: 'single',
    callSid,
    operation: 'hubspot_update_sms_consent',
    inputs: {
      contactId,
      consent,
      consentTsISO
    }
  });

  return withIdempotency({
    key,
    loggerContext: { callSid, operation: 'hubspot_update_sms_consent' },
    fn: async () => {
      await hubspotRequest(`/crm/v3/objects/contacts/${contactId}`, {
        method: 'PATCH',
        body: payload
      });

      return {
        ok: true,
        contactId,
        consent,
        consentTsISO
      };
    }
  });
}
module.exports = {
  findContactByPhone,
  getContactById,
  upsertContact,
  createDeal,
  associateDealToContact,
  logEngagement,
  updateDealStage,
  updateContactConsent,
  LOCKED_PIPELINE_ID,
  LOCKED_STAGE_ID
};
