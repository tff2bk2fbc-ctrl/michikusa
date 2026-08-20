import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const read = name => readFile(new URL(name, root), 'utf8');

function channel(value){
  const n=parseInt(value,16)/255;
  return n<=0.04045?n/12.92:Math.pow((n+0.055)/1.055,2.4);
}
function contrast(foreground,background){
  const rgb=value=>[value.slice(1,3),value.slice(3,5),value.slice(5,7)].map(channel);
  const luminance=value=>{const [r,g,b]=rgb(value);return 0.2126*r+0.7152*g+0.0722*b;};
  const a=luminance(foreground),b=luminance(background);
  return (Math.max(a,b)+0.05)/(Math.min(a,b)+0.05);
}

test('初回案内は指定順で、現在版の規約同意だけを再利用する', async () => {
  const [html,boot,onboarding] = await Promise.all([
    read('public/index.html'),read('public/boot.js'),read('public/onboarding.js')
  ]);
  assert.match(html,/id="onboarding" hidden/);
  assert.match(html,/id="onboarding-legal"/);
  assert.ok(html.indexOf('/sync.js?v=124') < html.indexOf('/onboarding.js?v=124'));
  assert.match(boot,/SPOTA_ONBOARDING_VERSION='2026-08-17\.1'/);
  const expected=['welcome()','permissionScreen(\'notification\'','permissionScreen(\'media\'',
    'permissionScreen(\'location\'','terms()','login()','profile()'];
  let cursor=-1;
  for(const item of expected){const next=onboarding.indexOf(item,cursor+1);assert.ok(next>cursor,item);cursor=next;}
  assert.match(onboarding,/value\.terms===version&&value\.privacy===version&&value\.accepted_at/);
  assert.match(onboarding,/terms:version,privacy:version,accepted_at:new Date\(\)\.toISOString\(\)/);
  assert.match(onboarding,/stageKey='spota_onboarding_stage_'\+String\(version\)/);
  assert.match(onboarding,/localStorage\.getItem\(stageKey\)/);
  assert.match(onboarding,/localStorage\.removeItem\('spota_onboarding_stage'\)/);
});

test('OS権限と地図通信は説明後にだけ開始し、位置は規約同意前に取得しない', async () => {
  const [native,map,data,sync,onboarding] = await Promise.all([
    read('public/native.js'),read('public/map.js'),read('public/data.js'),
    read('public/sync.js'),read('public/onboarding.js')
  ]);
  for(const name of ['requestSpotaNotificationPermission','requestSpotaMediaPermissions','requestSpotaLocationPermission'])
    assert.match(native,new RegExp('window\\.'+name+'='+name));
  const locationStart=native.indexOf('async function requestSpotaLocationPermission');
  const locationEnd=native.indexOf('window.requestSpotaNotificationPermission',locationStart);
  assert.doesNotMatch(native.slice(locationStart,locationEnd),/getCurrentPosition|whereAmI/);
  assert.match(native,/if\(window\.__spotaOnboardingActive\|\|window\.__spotaNeedsOnboarding\)return;/);
  assert.match(map,/!window\.__spotaOnboardingActive&&!window\.__spotaNeedsOnboarding/);
  assert.match(map,/var deferInitialMap=!!\(window\.__spotaOnboardingActive\|\|window\.__spotaNeedsOnboarding\)/);
  assert.match(map,/window\.startSpotaMapAfterOnboarding=startSpotaMapAfterOnboarding/);
  assert.match(map,/if\(!deferInitialMap\)startSpotaMapAfterOnboarding\(\)/);
  assert.match(data,/if\(window\.__spotaOnboardingActive\|\|window\.__spotaNeedsOnboarding\)/);
  assert.match(sync,/async function syncDown\(\)\{\s*if\(window\.__spotaOnboardingActive\|\|window\.__spotaNeedsOnboarding\)return;/);
  assert.match(onboarding,/mapWasDeferred=window\.startSpotaMapAfterOnboarding\(\)/);
  const push=native.slice(native.indexOf('async function setupPush'),native.indexOf('\/\* ============================================================\n   起動したら'));
  assert.doesNotMatch(native,/plugin\('PushNotifications'\)/);
  assert.match(push,/if\(!requestPermission\)return result\('permission_prompt'/);
  assert.match(push,/plugin\('FirebaseMessaging'\)/);
  assert.match(push,/P\.getToken\(\)/);
  assert.match(push,/tokenReceived/);
  assert.doesNotMatch(push,/plugin\('PushNotifications'\)/);
  assert.match(push,/permission_denied/);
  assert.match(push,/token_save_failed/);
  assert.match(push,/registration_timeout/);
  assert.match(push,/return \{ok:code==='registered',code:code,message:message\|\|''\}/);
});

test('一度だけのリセットは認証と通知先だけを外し、投稿と写真を削除しない', async () => {
  const sync=await read('public/sync.js');
  const start=sync.indexOf('async function resetExistingLoginForOnboarding');
  const end=sync.indexOf('async function startAuthenticatedSession',start);
  const reset=sync.slice(start,end);
  assert.match(reset,/spota_push_token/);
  assert.match(reset,/\/api\/push\/token/);
  assert.match(reset,/FA\.signOut/);
  assert.match(reset,/firebase\.auth\(\)\.signOut/);
  assert.doesNotMatch(reset,/dbDel|indexedDB\.deleteDatabase|\/api\/posts|\/api\/photo|PHOTOS/);
  assert.match(sync,/if\(window\.__spotaOnboardingActive\)return;/);
  assert.match(sync,/resumeSpotaAfterOnboarding/);
});

test('規約同意APIは認証後にあり、最小項目だけをD1へ保存する', async () => {
  const [worker,migration,sync] = await Promise.all([
    read('src/index.js'),read('migrations/0004_legal_acceptance.sql'),read('public/sync.js')
  ]);
  const auth=worker.indexOf('const me = await authenticate(request, env)');
  const route=worker.indexOf('p === "/api/legal/acceptance"');
  assert.ok(route>auth);
  assert.match(worker,/userLimit\(env, me\.id, "legal-acceptance-hour"/);
  assert.match(worker,/termsVersion !== CURRENT_TERMS_VERSION \|\| privacyVersion !== CURRENT_PRIVACY_VERSION/);
  assert.match(worker,/acceptedAt > now \+ 300_000/);
  assert.match(migration,/PRIMARY KEY \(user_id, terms_version, privacy_version\)/);
  assert.doesNotMatch(migration,/photo|lat|lng|display_name|email/i);
  assert.match(sync,/terms_version:accepted\.terms,privacy_version:accepted\.privacy,accepted_at:accepted\.accepted_at/);

  const sqlite=spawnSync('sqlite3',[':memory:'],{encoding:'utf8',input:`
PRAGMA foreign_keys=ON;
CREATE TABLE users(id TEXT PRIMARY KEY);
INSERT INTO users VALUES('u1');
${migration}
INSERT INTO legal_acceptances VALUES('u1','2026-08-17.1','2026-08-17.1',1,2);
INSERT OR REPLACE INTO legal_acceptances VALUES('u1','2026-08-17.1','2026-08-17.1',1,3);
SELECT COUNT(*)||','||MAX(recorded_at) FROM legal_acceptances;
DELETE FROM users WHERE id='u1';
SELECT COUNT(*) FROM legal_acceptances;
`});
  assert.equal(sqlite.status,0,sqlite.stderr);
  assert.equal(sqlite.stdout.trim(),'1,3\n0');
});

test('規約はアプリ内から再表示でき、初回画面の主要色はAAを満たす', async () => {
  const [sync,terms,privacy,css] = await Promise.all([
    read('public/sync.js'),read('public/terms.html'),read('public/privacy.html'),read('public/app.css')
  ]);
  assert.match(sync,/id="me-terms"/);
  assert.match(sync,/id="me-privacy"/);
  assert.match(terms,/規約バージョン: 2026-08-17\.1/);
  assert.match(privacy,/ポリシーバージョン: 2026-08-17\.1/);
  assert.match(privacy,/同意した利用規約とプライバシーポリシーの版/);
  assert.match(terms,/請求窓口：<a href="mailto:/);
  assert.match(privacy,/請求窓口：<a href="mailto:/);
  assert.match(terms,/請求があった場合、下記の請求窓口から遅滞なく電子メール等/);
  assert.match(privacy,/請求があった場合、下記の請求窓口から遅滞なく電子メール等/);
  assert.match(privacy,/保有個人データに関する請求/);
  assert.match(privacy,/利用目的の通知、開示、訂正、追加、削除、利用停止、消去/);
  assert.match(terms,/一般の利益に適合する場合/);
  assert.doesNotMatch(terms+privacy,/公開前の必須入力|ここへ追記してください/);
  assert.doesNotMatch(terms+privacy,/—|–/);
  assert.match(css,/@media \(forced-colors:active\)/);
  assert.match(css,/@media \(prefers-reduced-motion:reduce\)/);
  for(const [foreground,background,min] of [
    ['#111111','#EFEDE8',4.5],['#5F5F5B','#EFEDE8',4.5],['#FFFFFF','#111111',4.5],
    ['#F2F2F4','#121214',4.5],['#B4B4BA','#121214',4.5],['#121214','#F2F2F4',4.5],
    ['#1D5FA7','#EFEDE8',3],['#91C5FF','#121214',3],['#B3261E','#EFEDE8',4.5],['#FF8A80','#121214',4.5]
  ])assert.ok(contrast(foreground,background)>=min,`${foreground} on ${background}`);
});

test('Appleログイン失敗時は秘密情報を出さず、再試行できるコードを表示する', async () => {
  const [sync,onboarding] = await Promise.all([read('public/sync.js'),read('public/onboarding.js')]);
  assert.match(sync,/function spotaAppleAuthErrorCode\(error\)/);
  assert.match(sync,/FA\.signInWithApple\(\{skipNativeAuth:true\}\)/);
  assert.match(sync,/auth\/operation-not-allowed/);
  assert.match(sync,/Appleの認証情報を確認できませんでした/);
  assert.match(sync,/window\.describeSpotaAppleAuthError=spotaAppleAuthErrorText/);
  assert.match(sync,/cancelled\.code='auth\/cancelled-popup-request'/);
  assert.match(onboarding,/button\.disabled=false/);
  assert.match(onboarding,/describeSpotaAppleAuthError/);
  assert.doesNotMatch(onboarding,/error\.message/);
});

test('通知設定オンとFCM/D1端末登録を分けてモニターへ伝える', async () => {
  const [native,sync,installer,delegate] = await Promise.all([
    read('public/native.js'),read('public/sync.js'),read('native/ios/apply-to-capacitor.sh'),
    read('native/ios/AppDelegate.swift')
  ]);
  const setup=native.slice(native.indexOf('async function setupPush'),native.indexOf('window.setupSpotaPush=setupPush'));
  assert.match(setup,/code==='registered'/);
  assert.match(setup,/fcm_token_error/);
  assert.match(setup,/tokenReceived/);
  assert.match(setup,/notificationReceived/);
  assert.match(setup,/notificationActionPerformed/);
  assert.match(setup,/tokenResult\.token/);
  assert.doesNotMatch(setup,/addListener\('registration'/);
  assert.match(setup,/setTimeout\(function\(\)\{resolve\(null\);\},8000\)/);
  assert.match(installer,/npm uninstall @capacitor\/push-notifications/);
  assert.match(installer,/npm install @capacitor-firebase\/messaging@8\.4\.0 firebase/);
  assert.match(installer,/plugins\.delete\("PushNotifications"\)/);
  assert.match(installer,/options\["@capacitor-firebase\/messaging"\]/);
  assert.match(installer,/FirebaseMessagingAutoInitEnabled false/);
  assert.match(delegate,/didReceiveRemoteNotification userInfo/);
  assert.match(delegate,/Notification\.Name\("didReceiveRemoteNotification"\)/);
  assert.match(setup,/token_save_failed/);
  assert.match(setup,/通知はオンですが/);
  assert.match(sync,/var push=window\.setupSpotaPush&&await window\.setupSpotaPush\(true\)/);
  assert.match(sync,/!push\|\|!push\.ok/);
  assert.match(sync,/pushMessage\+='（コード: '\+String\(push\.code\)/);
  assert.doesNotMatch(sync,/通知が許可されていないか、端末の登録を完了できませんでした/);
});
