const COMPANY_ALLOWLIST = Object.freeze([
  'deployment_status',
  'forwarding_verified',
  'twilio_inbound_number',
  'twilio_number_sid',
  'escalation_phone',
  'business_timezone',
  'calendar_id'
]);

const CONTACT_ALLOWLIST = Object.freeze([
  'firstname',
  'lastname',
  'phone',
  'service_street_1',
  'service_city',
  'service_state',
  'service_postal_code',
  'sms_customer_consent',
  'sms_customer_consent_ts'
]);

const DEAL_ALLOWLIST = Object.freeze([
  'pipeline',
  'dealstage',
  'call_disposition'
]);

function filterProps(input, allowlist, objectName) {
  const source = input || {};
  const keys = Object.keys(source).sort();
  const properties = {};

  for (const key of keys) {
    if (!allowlist.includes(key)) {
      throw new Error(`${objectName} property is not allowlisted: ${key}`);
    }

    const value = source[key];
    if (value !== undefined) {
      properties[key] = value;
    }
  }

  return { properties };
}

function filterCompanyProps(input) {
  return filterProps(input, COMPANY_ALLOWLIST, 'company');
}

function filterContactProps(input) {
  return filterProps(input, CONTACT_ALLOWLIST, 'contact');
}

function filterDealProps(input) {
  return filterProps(input, DEAL_ALLOWLIST, 'deal');
}

module.exports = {
  filterCompanyProps,
  filterContactProps,
  filterDealProps
};
