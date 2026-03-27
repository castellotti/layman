/**
 * PII category definitions based on international privacy regulations
 * (GDPR, ISO 29100, PIPL, US security breach acts, India IT rules).
 *
 * Each category includes whether it is actively detected via regex patterns.
 */

export interface PiiCategory {
  id: string;
  label: string;
  description: string;
  group: 'direct' | 'indirect' | 'special';
  detected: boolean;
}

export const PII_CATEGORIES: PiiCategory[] = [
  // --- Direct identifiers (regex-detectable) ---
  {
    id: 'email',
    label: 'Email addresses',
    description: 'Business or personal email addresses',
    group: 'direct',
    detected: true,
  },
  {
    id: 'phone',
    label: 'Phone numbers',
    description: 'Telephone numbers in international or local formats',
    group: 'direct',
    detected: true,
  },
  {
    id: 'ipv4',
    label: 'IPv4 addresses',
    description: 'Internet Protocol version 4 addresses',
    group: 'direct',
    detected: true,
  },
  {
    id: 'ipv6',
    label: 'IPv6 addresses',
    description: 'Internet Protocol version 6 addresses',
    group: 'direct',
    detected: true,
  },
  {
    id: 'mac',
    label: 'MAC addresses',
    description: 'Hardware/network interface identifiers',
    group: 'direct',
    detected: true,
  },
  {
    id: 'ssn',
    label: 'Social security / tax numbers',
    description: 'National identification, social security, or tax ID numbers',
    group: 'direct',
    detected: true,
  },
  {
    id: 'credit_card',
    label: 'Credit card numbers',
    description: 'Payment card numbers (Visa, Mastercard, Amex, etc.)',
    group: 'direct',
    detected: true,
  },
  {
    id: 'iban',
    label: 'Bank account / IBAN numbers',
    description: 'International Bank Account Numbers and similar identifiers',
    group: 'direct',
    detected: true,
  },
  {
    id: 'passport',
    label: 'Passport numbers',
    description: 'Government-issued passport document numbers',
    group: 'direct',
    detected: true,
  },
  {
    id: 'drivers_license',
    label: "Driver's license numbers",
    description: "Driver's license or permit identifiers",
    group: 'direct',
    detected: true,
  },
  {
    id: 'api_key',
    label: 'API keys',
    description: 'Provider API keys including Anthropic (sk-ant-) and OpenAI (sk-) formats',
    group: 'direct',
    detected: true,
  },
  {
    id: 'access_token',
    label: 'Access tokens',
    description: 'GitHub tokens (ghp_, github_pat_, gho_, ghu_, ghs_, ghr_) and other bearer tokens',
    group: 'direct',
    detected: true,
  },
  {
    id: 'device_id',
    label: 'Device identifiers',
    description: 'Apple iOS UDIDs, IDFAs, Android device IDs, and advertising IDs',
    group: 'direct',
    detected: true,
  },
  {
    id: 'secret',
    label: 'Passwords / secrets / private keys',
    description: 'Credentials, passwords, private keys, and JWTs',
    group: 'direct',
    detected: true,
  },

  // --- Indirect identifiers (reference only, not regex-detectable) ---
  {
    id: 'name',
    label: 'Personal names',
    description: 'First name, last name, full name of natural persons',
    group: 'indirect',
    detected: false,
  },
  {
    id: 'postal_address',
    label: 'Postal addresses',
    description: 'Street addresses, ZIP/postal codes, city, country',
    group: 'indirect',
    detected: false,
  },
  {
    id: 'user_id',
    label: 'User / customer / supplier IDs',
    description: 'System-specific identifiers that map to a natural person',
    group: 'indirect',
    detected: false,
  },
  {
    id: 'biometric',
    label: 'Biometric data',
    description: 'Fingerprints, facial recognition data, voice prints',
    group: 'indirect',
    detected: false,
  },
  {
    id: 'geolocation',
    label: 'Geo-location data',
    description: 'GPS coordinates or location tracking information',
    group: 'indirect',
    detected: false,
  },
  {
    id: 'dob',
    label: 'Date of birth',
    description: 'Birth date that can contribute to identification',
    group: 'indirect',
    detected: false,
  },

  // --- Special categories (sensitive personal data, reference only) ---
  {
    id: 'racial_ethnic',
    label: 'Racial or ethnic origin',
    description: 'Data revealing racial or ethnic background',
    group: 'special',
    detected: false,
  },
  {
    id: 'political',
    label: 'Political opinions',
    description: 'Political party membership or beliefs',
    group: 'special',
    detected: false,
  },
  {
    id: 'religious',
    label: 'Religious or philosophical beliefs',
    description: 'Faith, religious membership, or philosophical convictions',
    group: 'special',
    detected: false,
  },
  {
    id: 'trade_union',
    label: 'Trade-union membership',
    description: 'Membership in trade unions or labor organizations',
    group: 'special',
    detected: false,
  },
  {
    id: 'health',
    label: 'Health / medical data',
    description: 'Medical records, health conditions, prescriptions',
    group: 'special',
    detected: false,
  },
  {
    id: 'sexual_orientation',
    label: 'Sexual orientation',
    description: 'Data concerning sex life or sexual orientation',
    group: 'special',
    detected: false,
  },
  {
    id: 'criminal',
    label: 'Criminal records',
    description: 'Criminal proceedings, convictions, or involvement',
    group: 'special',
    detected: false,
  },
];

export const PII_GROUPS: Record<'direct' | 'indirect' | 'special', string> = {
  direct: 'Direct Identifiers (auto-detected)',
  indirect: 'Indirect Identifiers (reference)',
  special: 'Special Categories (reference)',
};
