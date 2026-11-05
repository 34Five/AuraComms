import { HttpError, type Env } from './types.ts';

// The fixed demo binding has a sender allowlist. New addresses use the account's
// Email Sending API after Governance has checked their active tenant assignment.
export function generatedSenderReady(env: Env) {
  return !!env.CLOUDFLARE_DOMAIN_API_TOKEN && !!env.CLOUDFLARE_ACCOUNT_ID;
}
export async function sendGenerated(env: Env, builder: EmailReplyMessageBuilder, recipients: {to:string[];cc?:string[];bcc?:string[]}): Promise<EmailSendResult> {
  if(!generatedSenderReady(env)) throw new HttpError(503,'Email Sending credentials are not configured for generated addresses.');
  const from=typeof builder.from==='string'?builder.from:builder.from.email;
  const messageId=`${crypto.randomUUID()}@${from.split('@')[1]}`;
  const attachments=(builder.attachments??[]).map(a=>{
    const bytes=typeof a.content==='string'?new TextEncoder().encode(a.content):ArrayBuffer.isView(a.content)?new Uint8Array(a.content.buffer,a.content.byteOffset,a.content.byteLength):new Uint8Array(a.content);
    let binary='';for(let offset=0;offset<bytes.length;offset+=8192)binary+=String.fromCharCode(...bytes.subarray(offset,offset+8192));
    return {...a,content:btoa(binary)};
  });
  const response=await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/email/sending/send`,{
    method:'POST',signal:AbortSignal.timeout(20_000),
    headers:{Authorization:`Bearer ${env.CLOUDFLARE_DOMAIN_API_TOKEN}`,'Content-Type':'application/json'},
    body:JSON.stringify({...builder,...recipients,headers:{...builder.headers,'Message-ID':`<${messageId}>`},...(attachments.length?{attachments}:{})}),
  });
  const body=await response.json() as {success?:boolean;result?:{delivered?:string[];queued?:string[];permanent_bounces?:string[]}};
  if(!response.ok||!body.success||!body.result)throw new Error('Email Sending did not confirm acceptance.');
  const accepted=new Set([...(body.result.delivered??[]),...(body.result.queued??[])].map(v=>v.toLowerCase()));
  if([...recipients.to,...(recipients.cc??[]),...(recipients.bcc??[])].some(v=>!accepted.has(v.toLowerCase())))throw new Error('Email Sending did not confirm all recipients.');
  return {messageId:`<${messageId}>`};
}
