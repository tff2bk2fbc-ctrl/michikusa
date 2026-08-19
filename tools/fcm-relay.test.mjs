import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import test from 'node:test';
import {handleRelayRequest,sendFcmMessages} from '../services/fcm-relay/server.mjs';

const secret='relay-secret-'.repeat(3);
const env={FCM_RELAY_SHARED_SECRET:secret,FIREBASE_PROJECT_ID:'michikusa-e34df'};
const token='fcm-token-'+'x'.repeat(24);

function signedRequest(body,nonce,now=1_700_000_000){
  const timestamp=String(now);
  const signature=createHmac('sha256',secret).update(`${timestamp}.${nonce}.${body}`).digest('base64url');
  return new Request('https://relay.example/send',{method:'POST',headers:{
    'Content-Type':'application/json','Content-Length':String(Buffer.byteLength(body)),
    'X-Spota-Timestamp':timestamp,'X-Spota-Nonce':nonce,'X-Spota-Signature':signature
  },body});
}

function message(extra={}){return {message:{token,notification:{title:'spota',body:'test'},data:{monitor_run:'run-1'},...extra}};}

test('relay accepts one signed request, forwards through ADC, and returns accepted count',async()=>{
  let authCalls=0,fetchCalls=0;
  const body=JSON.stringify({messages:[message()]});
  const response=await handleRelayRequest(signedRequest(body,'nonce-accepted-0000000001'),env,{
    now:1_700_000_000_000,
    tokenProvider:async()=>{authCalls++;return 'adc-token';},
    fetchImpl:async(url,options)=>{fetchCalls++;assert.match(url,/projects\/michikusa-e34df\/messages:send$/);assert.equal(options.headers.Authorization,'Bearer adc-token');return new Response('{}',{status:200});}
  });
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{sent:1,code:'accepted',invalid_tokens:[]});
  assert.equal(authCalls,1); assert.equal(fetchCalls,1);
});

test('relay health endpoint is available at a non-reserved Cloud Run path',async()=>{
  const response=await handleRelayRequest(new Request('https://relay.example/health'),env);
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{ok:true});
});

test('relay rejects replay, stale signatures, and sensitive location data',async()=>{
  const body=JSON.stringify({messages:[message()]});
  const first=await handleRelayRequest(signedRequest(body,'nonce-replay-0000000001'),env,{now:1_700_000_000_000,tokenProvider:async()=>'',fetchImpl:async()=>new Response('{}')});
  const replay=await handleRelayRequest(signedRequest(body,'nonce-replay-0000000001'),env,{now:1_700_000_000_000,tokenProvider:async()=>'',fetchImpl:async()=>new Response('{}')});
  assert.equal(first.status,200); assert.equal(replay.status,409);
  const stale=await handleRelayRequest(signedRequest(body,'nonce-stale-0000000001',1_699_999_000),env,{now:1_700_000_000_000});
  assert.equal(stale.status,401);
  const sensitive=JSON.stringify({messages:[message({data:{latitude:'35.0'}})]});
  const rejected=await handleRelayRequest(signedRequest(sensitive,'nonce-sensitive-0000001'),env,{now:1_700_000_000_000});
  assert.equal(rejected.status,400);
});

test('relay reports only unregistered tokens for cleanup',async()=>{
  const result=await sendFcmMessages([message(),message({token:token+'-bad'})],env,
    async(_url,options)=>options.body.includes(token+'-bad')
      ? new Response(JSON.stringify({error:{details:[{reason:'UNREGISTERED'}]}}),{status:404})
      : new Response('{}',{status:200}),
    async()=> 'adc-token');
  assert.equal(result.sent,1);
  assert.deepEqual(result.invalid_tokens,[token+'-bad']);
});
