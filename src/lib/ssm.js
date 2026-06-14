// Shared SSM secret loader: env override → SSM Parameter Store (decrypted).
// Several domains (qbo, fulcrum, zendesk, openai) need the same "prefer the env
// var, otherwise read SecureString from SSM" behavior; this centralizes it so
// new integrations don't re-implement the SSM plumbing. No secret is ever
// hardcoded — callers pass the SSM parameter name and the env var that overrides it.
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import { REGION } from "../qbo/config.js";

let ssm = null;
function client() {
  return (ssm ??= new SSMClient({ region: REGION }));
}

/**
 * @param {string} paramName  SSM parameter, e.g. "/rsg-ai/prod/openai-api-key"
 * @param {{ env?: string }} [opts]  env var name that, if set, wins over SSM
 */
export async function loadSecret(paramName, { env } = {}) {
  if (env && process.env[env]) return process.env[env];
  const res = await client().send(new GetParameterCommand({ Name: paramName, WithDecryption: true }));
  return res.Parameter.Value;
}
