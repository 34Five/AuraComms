export const RECIPIENT = 'bounce@axi4-spike-20261021.invalid';
export const REJECTION_ADDRESS = 'spike-bounce@34five.studio';
export const SENDER = 'spike-test@34five.studio';
export default {
  async email(message) {
    const expected = message.to.toLowerCase() === REJECTION_ADDRESS;
    const reason = expected ? 'AXI-4 controlled permanent rejection' : 'Recipient not configured for this test';
    console.log(JSON.stringify({event:'controlled_rejection',to:message.to,messageId:message.headers.get('message-id'),expected,reason}));
    message.setReject(reason);
  },
  async fetch(request, env) {
    const json = (body, status) => Response.json(body,{status,headers:{'Cache-Control':'no-store'}});
    const path = new URL(request.url).pathname;
    if(!['/send','/send-manual'].includes(path)) return json({error:'Not found'},404);
    if(!env.TEST_TOKEN || request.headers.get('Authorization') !== `Bearer ${env.TEST_TOKEN}`) return json({error:'Unauthorized'},401);
    if(request.method !== 'POST') return json({error:'Method not allowed'},405);
    try {
      const recipient = path === '/send-manual' ? env.MANUAL_TEST_RECIPIENT : RECIPIENT;
      if(!recipient) return json({error:'Configure MANUAL_TEST_RECIPIENT before testing'},400);
      const result = await env.EMAIL.send({from:SENDER,to:recipient,subject:'AXI-4 controlled bounce or suppression test',text:'This controlled test send should fail delivery or be blocked by the test suppression.'});
      console.log(JSON.stringify({event:'bounce_send_accepted',result}));
      return json({accepted:true,result},202);
    } catch(error) {
      const detail={accepted:false,name:error?.name,code:error?.code,message:String(error?.message ?? error)};
      console.log(JSON.stringify({event:'bounce_send_rejected',...detail}));
      return json(detail,502);
    }
  }
};
