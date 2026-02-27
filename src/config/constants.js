const path = require('path');

const DEFAULT_PORT = 8080;
const DEFAULT_OPENAI_REALTIME_MODEL = 'gpt-4o-realtime-preview-2024-12-17';
const DEFAULT_OPENAI_VOICE = 'alloy';
const DEFAULT_OPERATOR_COMPANY_NAME = 'Call Operator Pro Plumbing';
const DEFAULT_PROMPT_PATH = path.join(__dirname, '..', '..', 'prompts', 'plumbing_operator_system_prompt.txt');

module.exports = {
  DEFAULT_PORT,
  DEFAULT_OPENAI_REALTIME_MODEL,
  DEFAULT_OPENAI_VOICE,
  DEFAULT_OPERATOR_COMPANY_NAME,
  DEFAULT_PROMPT_PATH
};
