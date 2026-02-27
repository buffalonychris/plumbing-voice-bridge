const { filterContactProps, filterDealProps } = require('../governance/propertyAllowlist');

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

async function upsertContact(contactProps) {
  const payload = filterContactProps(contactProps);
  const phone = payload.properties.phone;

  if (!phone) {
    throw buildError({
      message: 'Contact upsert requires allowlisted phone property',
      code: 'missing_phone'
    });
  }

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

async function createDeal({ contactId, callSid }) {
  const payload = filterDealProps({
    pipeline: LOCKED_PIPELINE_ID,
    dealstage: LOCKED_STAGE_ID,
    call_disposition: 'missed_call_captured'
  });

  const created = await hubspotRequest('/crm/v3/objects/deals', {
    method: 'POST',
    body: payload
  });

  return { id: created.id, contactId, callSid };
}

async function associateDealToContact(dealId, contactId) {
  await hubspotRequest(`/crm/v3/objects/deals/${dealId}/associations/contacts/${contactId}/deal_to_contact`, {
    method: 'PUT'
  });
}

async function logEngagement(dealId, contactId, payload = {}) {
  const noteBody = 'Call started. TranscriptRef: pending. Summary: pending.';

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
    callSid: payload.callSid || null
  };
}

module.exports = {
  findContactByPhone,
  upsertContact,
  createDeal,
  associateDealToContact,
  logEngagement,
  LOCKED_PIPELINE_ID,
  LOCKED_STAGE_ID
};
