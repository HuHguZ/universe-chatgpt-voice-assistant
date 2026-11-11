import assert from 'node:assert/strict';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { createLiveCallServer } from '../src/matrix/live-server.ts';
import { testSpeech } from '../scripts/test-audio.ts';
await testSpeech(true);
const app = await createLiveCallServer();
app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
const url=`http://127.0.0.1:${(app.server.address() as any).port}`;
const browser=await chromium.launch({channel:'chromium',headless:true,args:['--use-fake-device-for-media-stream',`--use-file-for-fake-audio-capture=${resolve('runtime/test-command.wav')}%noloop`,'--autoplay-policy=no-user-gesture-required','--mute-audio']});
try{
  const context=await browser.newContext({viewport:{width:1280,height:900}});await context.grantPermissions(['microphone'],{origin:url});
  const page=await context.newPage();await page.goto(url);
  await page.evaluate(()=>{(window as any).audible=0;(window as any).sonoraMatrixAudio=(audio:any)=>{const raw=atob(audio.data);const data=new DataView(Uint8Array.from(raw,c=>c.charCodeAt(0)).buffer);let power=0;for(let n=0;n<raw.length;n+=2)power+=data.getInt16(n,true)**2;if(power/(raw.length/2)>200**2)(window as any).audible++;};});
  await page.getByRole('button',{name:'Войти в звонок'}).click();
  await page.waitForFunction(()=>['ready','error'].includes(document.body.dataset.phase!),undefined,{timeout:80000});
  assert.equal(await page.locator('body').getAttribute('data-phase'),'ready',await page.locator('#status').textContent()??'');
  await page.screenshot({path:'runtime/live-call.png'});
  await page.evaluate(()=>{const state=(window as any).sonoraMatrix.state;const a=state.context.createAnalyser();state.context.createMediaStreamSource(state.microphone).connect(a);(window as any).micAnalyser=a;});
  let peak=0;
  for(let n=0;;n++){
    const current=await page.evaluate(async()=>({status:await(await fetch('/status')).json(),audible:(window as any).audible}));
    peak=Math.max(peak,await page.evaluate(()=>{const a=(window as any).micAnalyser;const samples=new Float32Array(a.fftSize);a.getFloatTimeDomainData(samples);return Math.max(...samples.map(Math.abs));}));
    if(n%20===0)console.log(JSON.stringify({...current,microphonePeak:peak}));
    if(current.status.toolsCompleted>=1&&current.audible>=30)break;
    assert.ok(n<120,JSON.stringify(current)); await delay(500);
  }
  await page.getByRole('button',{name:'Выключить микрофон'}).click();
  assert.equal(await page.evaluate(()=>(window as any).sonoraMatrix.state.microphone.getAudioTracks()[0].enabled),false);
  const status=await page.evaluate(async()=>await(await fetch('/status')).json());
  const audible=await page.evaluate(()=>(window as any).audible);
  assert.ok(status.toolsCompleted>=1&&audible>=30);
  await page.getByRole('button',{name:'Завершить звонок'}).click();
  await page.getByRole('button',{name:'Войти в звонок'}).waitFor({state:'visible',timeout:10000});
  assert.equal(await page.evaluate(()=>(window as any).sonoraMatrix.state.microphone.getAudioTracks()[0].readyState),'ended');
  console.log(JSON.stringify({liveBrowserCall:true,fakeMicrophoneSpeech:true,encrypted: true,toolsCompleted:status.toolsCompleted,audibleReplyFrames:audible,mute:true,leave:true}));
}finally{await browser.close();await app.close();}
