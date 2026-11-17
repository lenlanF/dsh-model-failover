import test from 'node:test';
import assert from 'node:assert/strict';
import {apply} from '../lib/index.js';
import {normalizeRules,qualifies} from '../lib/rules.js';
import {createMockContext,createMockAgent,createUserMessage} from './helpers/mock-runtime.js';

const CHAIN = [{provider:'p',model:'a',free:true},{provider:'p',model:'paid'}];
function harness(config={}, {agentOptions={},settings,agents}={}) {
  const agent=createMockAgent({selection:{provider:'p',model:'a'},...agentOptions});
  const configured=agents??[agent];
  const ctx=createMockContext({agents:configured,get:settings?key=>key==='settings'?settings:undefined:undefined});
  const plugin=apply(ctx,config,{createUserMessage});
  return {agent,ctx,plugin};
}
const preStep=(ctx,agent)=>ctx.emit('agent/pre-step',{agent,messages:[],signal:{aborted:false}},()=>({kind:'enter'}));
test('saved direct config restores free mode and spent-route history',()=>{
 const now=Date.now();
 const agent=createMockAgent({selection:{provider:'p',model:'paid'}});
 const ctx=createMockContext({agents:[agent]});
 ctx.fiber={entry:{options:{id:'dsh-model-failover',config:{
  mode:'free',priority:CHAIN,exhaustedRoutes:{'p/a':now},exhaustionCooldownMs:120000}}}};
 const plugin=apply(ctx,{}, {createUserMessage});
 assert.equal(plugin.mode,'free');
 assert.equal(plugin.getRules().exhaustedRoutes?.['p/a']??plugin.getRules().exhausted?.['p/a'],now);
});
test('free mode rejects step when every free model is exhausted',async()=>{
 const now=Date.now();
 const {ctx,agent}=harness({mode:'free',priority:CHAIN,exhaustedRoutes:{'p/a':now}},{agentOptions:{selection:{provider:'p',model:'paid'}}});
 const ret=await preStep(ctx,agent);
 assert.equal(ret.value.kind,'reject');
 assert.equal(agent.selects.length,0);
});
test('free mode never manually restores a paid route when no free entry exists',()=>{
 const {agent,plugin}=harness({mode:'free',priority:[{provider:'p',model:'paid'}]},{agentOptions:{selection:{provider:'p',model:'other'}}});
 assert.equal(plugin.manualRestore(agent),undefined);
 assert.deepEqual(agent.selects,[]);
});
test('partial config refresh preserves the existing failover chain',()=>{
 const {plugin}=harness({priority:CHAIN,mode:'free'});
 plugin.refresh({enabled:false});
 assert.equal(plugin.rules.priority.length,2);
 assert.equal(plugin.mode,'free');
});
test('exhaustion cooldown duration is normalized from user configuration',()=>{
 assert.equal(normalizeRules({priority:CHAIN,exhaustionCooldownMs:90000}).exhaustionCooldownMs,90000);
});
function response(){
  return {statusCode:200,setHeader(){},end(raw){this.body=JSON.parse(raw)}};
}
function request(method, body){
  return {method,socket:{remoteAddress:'127.0.0.1'},headers:{origin:'http://localhost'},
    on(event,cb){if(event==='data' && body!==undefined)cb(Buffer.from(JSON.stringify(body)));
      if(event==='end')queueMicrotask(cb);return this;}};
}
function registeredContext(agents,mutate=async()=>{}){
  const registered=[];
  const settings={describe:()=>[{ns:'dsh-model-failover'}],mutate,configure(){}};
  const server={register(route){registered.push(route);return()=>{}}};
  const ctx=createMockContext({agents,get:key=>key==='settings'?settings:key==='webServer'?server:undefined});
  ctx.agents.list=()=>agents;
  return {ctx,registered};
}
test('failed persistent config write leaves runtime untouched',async()=>{
  const agent=createMockAgent({selection:{provider:'p',model:'a'}});
  const {ctx,registered}=registeredContext([agent],async()=>{throw new Error('disk full')});
  const handle=apply(ctx,{priority:CHAIN,enabled:true,mode:'free'},{createUserMessage});
  const route=registered.find(r=>r.path.endsWith('/config'));
  const res=response();
  await route.handler(request('POST',{enabled:false,mode:'off',priority:[]}),res);
  assert.equal(res.statusCode,500);
  assert.equal(handle.rules.enabled,true);
  assert.equal(handle.mode,'free');
  assert.deepEqual(handle.rules.priority.map(x=>x.model),['a','paid']);
});
test('clearing the model ladder is a legitimate saved configuration',async()=>{
  const agent=createMockAgent({selection:{provider:'p',model:'a'}});
  const writes=[];
  const {ctx,registered}=registeredContext([agent],async(...args)=>{writes.push(args)});
  const handle=apply(ctx,{priority:CHAIN,enabled:true},{createUserMessage});
  const res=response();
  await registered.find(r=>r.path.endsWith('/config')).handler(request('POST',{priority:[]}),res);
  assert.equal(res.body.ok,true);
  assert.equal(handle.rules.priority.length,0);
  assert.equal(writes.length,1);
});
test('restore requires explicit target with multiple agents and never mutates the first by accident',async()=>{
  const first=createMockAgent({id:'session-one',selection:{provider:'p',model:'outside'}});
  const second=createMockAgent({id:'session-two',selection:{provider:'p',model:'outside'}});
  const {ctx,registered}=registeredContext([first,second]);
  apply(ctx,{priority:CHAIN,mode:'pinned'},{createUserMessage});
  const route=registered.find(r=>r.path.endsWith('/restore'));
  const get=response(); await route.handler(request('GET'),get);
  assert.deepEqual(get.body.agents,['session-one','session-two']);
  const ambiguous=response();await route.handler(request('POST'),ambiguous);
  assert.equal(ambiguous.statusCode,409);
  assert.equal(first.selects.length,0);
  assert.equal(second.selects.length,0);
  const chosen=response();await route.handler(request('POST',{agentId:'session-two'}),chosen);
  assert.equal(chosen.body.ok,true);
  assert.equal(second.selects.length,1);
  assert.equal(first.selects.length,0);
});
test('exhausted selected free model is replaced by another usable free model',async()=>{
  const now=Date.now();
  const list=[{provider:'p',model:'a',free:true},{provider:'p',model:'b',free:true}];
  const {ctx,agent}=harness({mode:'free',priority:list,exhaustedRoutes:{'p/a':now}});
  const ret=await preStep(ctx,agent);
  assert.equal(ret.value.kind,'enter');
  assert.equal(agent.model.current().model,'b');
});

test('UNKNOWN terminated stream qualifies as transport error only when configured',()=>{
  const fail={code:'UNKNOWN',message:'terminated'};
  assert.equal(qualifies(fail,normalizeRules({triggers:['TRANSPORT']})),true);
  assert.equal(qualifies(fail,normalizeRules({triggers:['QUOTA']})),false);
  assert.equal(qualifies({code:'AUTH',message:'terminated'},normalizeRules({triggers:['TRANSPORT']})),false);
});
