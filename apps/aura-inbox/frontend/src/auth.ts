export type User={member_id:string;name:string;email:string;role:'admin'|'manager'|'reviewer'};
export async function workspaceFetch(input: string,init?:RequestInit): Promise<Response> {
  const response=await fetch(input,{...init,credentials:'same-origin',cache:'no-store'});
  if(response.status===401 && !init?.signal?.aborted) window.dispatchEvent(new Event('workspace-session-expired'));
  return response;
}
