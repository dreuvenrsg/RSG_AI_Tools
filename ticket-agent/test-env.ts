import * as dotenv from 'dotenv';
const result = dotenv.config();

console.log('Dotenv config result:', result.error ? result.error.message : 'Success');
console.log('ZENDESK_API_TOKEN:', process.env.ZENDESK_API_TOKEN);
console.log('FULCRUM_TOKEN:', process.env.FULCRUM_TOKEN ? 'Present' : 'Missing');
