import { HttpError, type Env } from './types.ts';

export class SendError extends Error {
  outcome:'rejected'|'unknown';httpStatus:number|null;codes:number[];requestId:string|null;messageId:string|null;
  constructor(outcome:'rejected'|'unknown',httpStatus:number|null,codes:number[]=[],requestId:string|null=null,messageId:string|null=null) {
    super(outcome==='rejected'?'The email provider rejected the send request.':'The email provider did not confirm the send outcome.');
    this.outcome=outcome;this.httpStatus=httpStatus;this.codes=codes;this.requestId=requestId;this.messageId=messageId;
  }
}
export function sendErrorDetail(error: unknown) {
  return error instanceof SendError ? {outcome:error.outcome,http_status:error.httpStatus,codes:error.codes,request_id:error.requestId,provider_message_id:error.messageId} : {outcome:'unknown' as const,http_status:null,codes:[],request_id:null,provider_message_id:null};
}
export function sendFailureSummary(status:number|null,codes:number[]) {
  if(status===401||status===403)return 'Email Sending credentials or permissions were rejected. An administrator must check the sender configuration.';
  if(status===429)return 'The email provider rate limit was reached.';
  if(codes.includes(10202)||codes.includes(10001)||status===400)return 'The email provider rejected the message format or sender configuration.';
  return 'The email provider rejected the send request. An administrator must check its error details.';
}
export function generatedSenderReady(env: Env) {
  return !!env.CLOUDFLARE_DOMAIN_API_TOKEN && !!env.CLOUDFLARE_ACCOUNT_ID;
}
const endpoint=(env:Env)=>`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/email/sending/send`;
const headers=(env:Env)=>({Authorization:`Bearer ${env.CLOUDFLARE_DOMAIN_API_TOKEN}`,'Content-Type':'application/json'});
const providerCodes=(body:any):number[]=>Array.isArray(body?.errors)?body.errors.map((e:any)=>e?.code).filter((code:unknown)=>Number.isSafeInteger(code)).slice(0,10):[];
const requestId=(response:Response)=>response.headers.get('cf-ray')?.match(/^[a-zA-Z0-9-]{1,80}$/)?.[0]??null;

export async function sendGenerated(env: Env, builder: EmailReplyMessageBuilder, recipients: {to:string[];cc?:string[];bcc?:string[]}): Promise<{messageId:string|null}> {
  if(!generatedSenderReady(env))throw new HttpError(503,'Email Sending credentials are not configured for generated addresses.');
  const attachments=(builder.attachments??[]).map(a=>{
    const bytes=typeof a.content==='string'?new TextEncoder().encode(a.content):ArrayBuffer.isView(a.content)?new Uint8Array(a.content.buffer,a.content.byteOffset,a.content.byteLength):new Uint8Array(a.content);
    let binary='';for(let offset=0;offset<bytes.length;offset+=8192)binary+=String.fromCharCode(...bytes.subarray(offset,offset+8192));
    const {contentId,...fields}=a as EmailAttachment & {contentId?:string};
    return {...fields,content:btoa(binary),...(contentId?{content_id:contentId}:{})};
  });
  const {replyTo,from,...fields}=builder;
  const restAddress=(value:string|EmailAddress)=>typeof value==='string'?value:{address:value.email,...(value.name?{name:value.name}:{})};
  let response:Response;
  try { response=await fetch(endpoint(env),{method:'POST',signal:AbortSignal.timeout(20_000),headers:headers(env),body:JSON.stringify({...fields,from:restAddress(from),...recipients,...(replyTo?{reply_to:restAddress(replyTo)}:{}),...(attachments.length?{attachments}:{})})}); }
  catch {throw new SendError('unknown',null);}
  const body=await response.json().catch(()=>null) as any;
  const codes=providerCodes(body),ray=requestId(response);
  // Only a structured, explicit client rejection establishes non-acceptance.
  if(!response.ok||body?.success!==true)throw new SendError(response.status>=400&&response.status<500&&response.status!==408&&body?.success===false&&!(body?.result?.delivered?.length||body?.result?.queued?.length)?'rejected':'unknown',response.status,codes,ray);
  const result=body.result;
  const id=typeof result?.message_id==='string'&&result.message_id.length<=998&&!/[\s\x00-\x1f\x7f]/.test(result.message_id)?result.message_id:null;
  if(!result||!Array.isArray(result.delivered)||!Array.isArray(result.queued)||[...result.delivered,...result.queued].some(v=>typeof v!=='string'))throw new SendError('unknown',response.status,codes,ray,id);
  const accepted=new Set([...result.delivered,...result.queued].map((v:string)=>v.toLowerCase()));
  if([...recipients.to,...(recipients.cc??[]),...(recipients.bcc??[])].some(v=>!accepted.has(v.toLowerCase())))throw new SendError('unknown',response.status,codes,ray,id);
  return {messageId:id};
}
