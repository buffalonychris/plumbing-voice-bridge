const REQUIRED_FIELDS_BY_TRANSITION = Object.freeze({
  CALL_STARTED: {
    IDENTITY_CHECKED: ['contact.firstname', 'contact.lastname']
  },
  IDENTITY_CHECKED: {
    ADDRESS_CONFIRMED: [
      'address.service_street_1',
      'address.service_city',
      'address.service_state',
      'address.service_postal_code'
    ]
  },
  ADDRESS_CONFIRMED: {
    PROBLEM_CAPTURED: ['problem.problem_summary']
  },
  PROBLEM_CAPTURED: {
    SCHEDULING: ['hubspot.crmReady', 'hubspot.contactId', 'hubspot.dealId', 'problem.problem_summary']
  },
  BOOKED: {
    CONFIRMED_SMS_SENT: ['booking.startISO', 'booking.endISO', 'contactConsent.consent', 'contactConsent.consentTsISO']
  }
});

function getByPath(obj, path) {
  return path.split('.').reduce((acc, key) => {
    if (acc == null) {
      return undefined;
    }

    return acc[key];
  }, obj);
}

function hasRequiredFieldsForTransition(session, nextState) {
  const fromState = session?.state;
  const requiredPaths = REQUIRED_FIELDS_BY_TRANSITION[fromState]?.[nextState] || [];

  const missing = requiredPaths.filter((path) => {
    const value = getByPath(session, path);
    if (typeof value === 'boolean') {
      return value !== true;
    }

    return value == null || value === '';
  });

  return {
    ok: missing.length === 0,
    fromState,
    nextState,
    requiredPaths,
    missing
  };
}

module.exports = {
  REQUIRED_FIELDS_BY_TRANSITION,
  hasRequiredFieldsForTransition
};
