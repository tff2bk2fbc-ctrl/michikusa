import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {createMonitorArtifacts,cleanupCommunicationMonitors,fcmRelayConfigured,relaySignature,isLegacyApnsToken} from '../src/index.js';

const root=new URL('../',import.meta.url);
const read=name=>readFileSync(new URL(name,root),'utf8');

function d1(database){
  return {
    prepare(sql){
      const query={sql,values:[]};
      query.bind=(...values)=>{query.values=values;return query;};
      query.run=async()=>{const out=database.prepare(sql).run(...query.values);return {meta:{changes:Number(out.changes),last_row_id:Number(out.lastInsertRowid||0)}};};
      query.first=async()=>database.prepare(sql).get(...query.values)||null;
      query.all=async()=>({results:database.prepare(sql).all(...query.values)});
      return query;
    },
    async batch(statements){return Promise.all(statements.map(statement=>statement.run()));}
  };
}

test('account safety migration cascades user data but keeps a de-identified deletion audit',()=>{
  const migration=read('migrations/0005_account_safety_monitor.sql');
  const sqlite=spawnSync('sqlite3',[':memory:'],{encoding:'utf8',input:`
PRAGMA foreign_keys=ON;
CREATE TABLE users(id TEXT PRIMARY KEY);
CREATE TABLE reports(id INTEGER PRIMARY KEY AUTOINCREMENT,reporter_id TEXT NOT NULL REFERENCES users(id),post_id TEXT,target_user TEXT REFERENCES users(id),reason TEXT NOT NULL,detail TEXT,status TEXT NOT NULL DEFAULT 'open',created_at INTEGER NOT NULL);
INSERT INTO users VALUES('u1'),('u2');
${migration}
INSERT INTO reports(reporter_id,target_user,reason,detail,client_operation_id,status,created_at,updated_at)
VALUES('u1','u2','spam','','operation_1','open',1,1);
INSERT INTO account_deletion_jobs(id,user_id,user_id_hash,provider,provider_uid_hash,status,requested_at,updated_at)
VALUES('j1','u1','hash-user','apple','hash-provider','completed',1,1);
INSERT INTO communication_monitor_runs(id,user_id,status,steps_json,created_at,expires_at)
VALUES('m1','u1','running','{}',1,2);
DELETE FROM reports WHERE reporter_id='u1' OR target_user='u1';
DELETE FROM users WHERE id='u1';
SELECT 'REPORTS='||COUNT(*) FROM reports;
SELECT 'MONITORS='||COUNT(*) FROM communication_monitor_runs;
SELECT 'JOBS='||COUNT(*) FROM account_deletion_jobs;
SELECT 'FK='||COUNT(*) FROM pragma_foreign_key_check;
`});
  assert.equal(sqlite.status,0,sqlite.stderr);
  assert.match(sqlite.stdout,/^REPORTS=0$/m);
  assert.match(sqlite.stdout,/^MONITORS=0$/m);
  assert.match(sqlite.stdout,/^JOBS=1$/m);
  assert.match(sqlite.stdout,/^FK=0$/m);
  assert.doesNotMatch(migration,/\b(lat|lng|email|push_token|device_token)\b/i);
});

test('account deletion requires recent reauthentication, Apple revocation, and shared-object protection',()=>{
  const worker=read('src/index.js');
  const auth=worker.indexOf('const me = await authenticate(request, env)');
  for(const route of ['/api/account/delete','/api/reports','/api/monitor/run','/api/monitor/receipt'])
    assert.ok(worker.indexOf(route)>auth,route);
  assert.match(worker,/payload\.auth_time[\s\S]{0,100}10 \* 60 \* 1000/);
  assert.match(worker,/provider === "apple" && parsed\.value\.apple_revoked !== true/);
  assert.match(worker,/identitytoolkit\.googleapis\.com\/v1\/accounts:delete/);
  assert.match(worker,/WHERE user_id<>\?1 AND \(key_orig=\?2 OR key_view=\?2 OR key_thumb=\?2\)/);
  assert.match(worker,/resumeAccountDeletions\(env\)/);
  assert.match(worker,/confirmation !== "削除"/);
  assert.match(worker,/recentDeletion[\s\S]{0,500}Date\.now\(\) - 2 \* 60 \* 60 \* 1000/);
  assert.match(worker,/const jobId = uuid\(\);[\s\S]{0,320}\.bind\(jobId, me\.id/);
  assert.doesNotMatch(worker,/account_deletion_jobs[\s\S]{0,240}\.bind\(id, me\.id/);
});

test('reporting is bounded, idempotent, and available on non-owned timeline posts',()=>{
  const worker=read('src/index.js'),release=read('public/release.js');
  const migration=read('migrations/0005_account_safety_monitor.sql');
  assert.match(worker,/userLimit\(env, me\.id, "reports-day", dayKey\(\), 20\)/);
  assert.match(migration,/CREATE UNIQUE INDEX IF NOT EXISTS reports_reporter_operation/);
  assert.match(worker,/if \(targetUserId === me\.id\)/);
  assert.match(release,/data-report=/);
  assert.match(release,/target_type:'post'/);
  assert.match(release,/client_operation_id:nid\(\)/);
  assert.match(release,/id="report-details" maxlength="500"/);
});

test('communication monitor distinguishes FCM acceptance, receipt, open, and visual confirmation',()=>{
  const worker=read('src/index.js'),native=read('public/native.js'),sync=read('public/sync.js');
  const config=JSON.parse(read('wrangler.jsonc'));
  assert.match(worker,/device_not_registered/);
  assert.match(worker,/fcm_not_configured/);
  assert.match(worker,/status IN \('running','push_accepted','received','opened','confirmed','failed'\)/);
  assert.match(worker,/env\.FCM_RELAY_SHARED_SECRET/);
  assert.match(worker,/X-Spota-Signature/);
  assert.match(worker,/relay_rate_limited/);
  for(const event of ['received','opened','confirmed'])assert.match(worker,new RegExp('"'+event+'"'));
  assert.match(native,/notificationReceived/);
  assert.match(native,/notificationActionPerformed/);
  assert.match(native,/receipt\(data,'received'\)/);
  assert.match(native,/receipt\(d,'opened'\)/);
  assert.match(sync,/通知が画面に見えた/);
  assert.match(sync,/event:'confirmed'/);
  assert.ok(config.vars.FIREBASE_PROJECT_ID);
  assert.doesNotMatch(worker,/monitor_run[^\n]{0,160}\b(lat|lng)\b/i);
  assert.doesNotMatch(worker,/DELETE FROM post_likes WHERE user_id=\?/);
});

test('iOS APNs device tokens cannot be stored or forwarded as FCM registration tokens',()=>{
  const worker=read('src/index.js');
  assert.equal(isLegacyApnsToken('a'.repeat(64),'ios'),true);
  assert.equal(isLegacyApnsToken('a'.repeat(64),'android'),false);
  assert.equal(isLegacyApnsToken('fcm-token-'+'x'.repeat(80),'ios'),false);
  assert.match(worker,/wrong_token_type/);
  assert.match(worker,/const tokens = await pushTokensForUser\(env, userId\)/);
  assert.match(worker,/token NOT GLOB '\*\[\^0-9A-Fa-f\]\*'/);
  assert.match(worker,/DELETE FROM push_tokens WHERE token=\? AND user_id=\?/);
});

test('FCM relay requires HTTPS and signs a nonce-bound request without a service-account key',async()=>{
  assert.equal(fcmRelayConfigured({FCM_RELAY_URL:'http://relay.example/send',FCM_RELAY_SHARED_SECRET:'x'.repeat(32)}),false);
  assert.equal(fcmRelayConfigured({FCM_RELAY_URL:'https://relay.example',FCM_RELAY_SHARED_SECRET:'short'}),false);
  assert.equal(fcmRelayConfigured({FCM_RELAY_URL:'https://relay.example',FCM_RELAY_SHARED_SECRET:'x'.repeat(32)}),true);
  const first=await relaySignature('x'.repeat(32),'1700000000','nonce-a','{"messages":[]}');
  const second=await relaySignature('x'.repeat(32),'1700000000','nonce-a','{"messages":[]}');
  const changed=await relaySignature('x'.repeat(32),'1700000000','nonce-b','{"messages":[]}');
  assert.equal(first,second);
  assert.notEqual(first,changed);
  assert.match(first,/^[A-Za-z0-9_-]{43}$/);
});

test('monitor artifacts execute against SQLite and cleanup removes only monitor-owned data',async()=>{
  const database=new DatabaseSync(':memory:');
  database.exec(`
PRAGMA foreign_keys=ON;
CREATE TABLE users(id TEXT PRIMARY KEY,handle TEXT UNIQUE,display_name TEXT NOT NULL DEFAULT '',bio TEXT NOT NULL DEFAULT '',default_visibility TEXT NOT NULL DEFAULT 'friends',friend_precision TEXT NOT NULL DEFAULT 'exact',public_precision TEXT NOT NULL DEFAULT 'approx',publish_delay_sec INTEGER NOT NULL DEFAULT 0,profile_public INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,deleted_at INTEGER,profile_icon TEXT NOT NULL DEFAULT 'pin');
CREATE TABLE posts(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,place_id TEXT,title TEXT NOT NULL DEFAULT '',category TEXT NOT NULL DEFAULT '景',tag TEXT NOT NULL DEFAULT '',place_name TEXT NOT NULL DEFAULT '',body TEXT NOT NULL DEFAULT '',lat REAL NOT NULL,lng REAL NOT NULL,approx_lat REAL NOT NULL,approx_lng REAL NOT NULL,area_lat REAL NOT NULL,area_lng REAL NOT NULL,fixed_lat REAL,fixed_lng REAL,fixed_label TEXT,taken_at INTEGER,created_at INTEGER NOT NULL,visibility TEXT NOT NULL DEFAULT 'friends',publish_at INTEGER NOT NULL,deleted_at INTEGER,social_announced_at INTEGER,client_operation_id TEXT);
CREATE TABLE photos(id TEXT PRIMARY KEY,post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,key_orig TEXT,key_view TEXT,key_thumb TEXT,width INTEGER,height INTEGER,sort_order INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,moderation_state TEXT,moderation_view_state TEXT,moderation_thumb_state TEXT);
CREATE TABLE friendships(id INTEGER PRIMARY KEY AUTOINCREMENT,requester_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,addressee_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,status TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(requester_id,addressee_id));
CREATE TABLE post_likes(post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,created_at INTEGER NOT NULL,PRIMARY KEY(post_id,user_id));
CREATE TABLE post_flashes(post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,recipient_count INTEGER NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(post_id,user_id));
CREATE TABLE conversations(id TEXT PRIMARY KEY,pair_key TEXT NOT NULL UNIQUE,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
CREATE TABLE conversation_members(conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,joined_at INTEGER NOT NULL,last_read_at INTEGER NOT NULL DEFAULT 0,last_read_id TEXT NOT NULL DEFAULT '',hidden_at INTEGER,PRIMARY KEY(conversation_id,user_id));
CREATE TABLE messages(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,body TEXT NOT NULL,client_operation_id TEXT,created_at INTEGER NOT NULL,deleted_at INTEGER);
CREATE TABLE notifications(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,kind TEXT NOT NULL,entity_type TEXT,entity_id TEXT,dedupe_key TEXT NOT NULL,created_at INTEGER NOT NULL,read_at INTEGER,UNIQUE(user_id,dedupe_key));
CREATE TABLE reports(id INTEGER PRIMARY KEY AUTOINCREMENT,reporter_id TEXT NOT NULL REFERENCES users(id),post_id TEXT REFERENCES posts(id),target_user TEXT REFERENCES users(id),reason TEXT NOT NULL,detail TEXT,status TEXT NOT NULL DEFAULT 'open',created_at INTEGER NOT NULL);
${read('migrations/0005_account_safety_monitor.sql')}
INSERT INTO users(id,handle,display_name,created_at) VALUES('user-1','tester','Tester',1);
INSERT INTO posts(id,user_id,title,lat,lng,approx_lat,approx_lng,area_lat,area_lng,created_at,visibility,publish_at) VALUES('user-post','user-1','test',35,139,35,139,35,139,1,'public',1);
INSERT INTO communication_monitor_runs(id,user_id,status,steps_json,created_at,expires_at) VALUES('monitor-run-1','user-1','running','{}',1,9999999999999);
`);
  const objects=new Map();
  const env={
    DB:d1(database),
    ASSETS:{fetch:async()=>new Response(new Uint8Array([0x89,0x50,0x4e,0x47]),{status:200,headers:{'Content-Type':'image/png'}})},
    PHOTOS:{put:async(key,value)=>objects.set(key,value),delete:async key=>objects.delete(key)}
  };
  const made=await createMonitorArtifacts(env,{id:'user-1'},'monitor-run-1');
  assert.deepEqual(made.steps,{post:true,message:true,like:true,flash:true,notification:true});
  assert.equal(database.prepare("SELECT COUNT(*) n FROM messages").get().n,1);
  assert.equal(database.prepare("SELECT COUNT(*) n FROM notifications").get().n,4);
  assert.equal(objects.size,3);
  database.prepare("UPDATE communication_monitor_runs SET created_at=? WHERE id='monitor-run-1'").run(Date.now()-20*60*1000);
  await cleanupCommunicationMonitors(env);
  assert.equal(database.prepare("SELECT COUNT(*) n FROM posts WHERE user_id='spota-system-monitor'").get().n,0);
  assert.equal(database.prepare("SELECT COUNT(*) n FROM communication_monitor_artifacts").get().n,0);
  assert.equal(objects.size,0);
  assert.equal(database.prepare("SELECT COUNT(*) n FROM posts WHERE id='user-post'").get().n,1);
});

test('native Apple Sign In and foreground push presentation are reproducible',()=>{
  const sync=read('public/sync.js'),onboarding=read('public/onboarding.js');
  const appDelegate=read('native/ios/AppDelegate.swift');
  const installer=read('native/ios/apply-to-capacitor.sh');
  const entitlements=read('native/ios/App.entitlements');
  assert.match(sync,/FA\.signInWithApple\(\)/);
  assert.match(sync,/OAuthProvider\('apple\.com'\)/);
  assert.match(sync,/FA\.revokeAccessToken\(\{token:code\}\)/);
  assert.match(onboarding,/id="onboarding-apple-login"/);
  assert.match(installer,/"apple\.com", "google\.com"/);
  assert.match(installer,/presentationOptions/);
  assert.match(installer,/CODE_SIGN_ENTITLEMENTS = App\/App\.entitlements/);
  assert.match(entitlements,/com\.apple\.developer\.applesignin/);
  assert.match(entitlements,/aps-environment/);
  assert.match(installer,/com\.apple\.Push/);
  assert.match(installer,/AppDelegate\.swift/);
  assert.match(appDelegate,/didRegisterForRemoteNotificationsWithDeviceToken/);
  assert.match(appDelegate,/capacitorDidRegisterForRemoteNotifications/);
  assert.match(appDelegate,/didFailToRegisterForRemoteNotificationsWithError/);
  assert.match(appDelegate,/capacitorDidFailToRegisterForRemoteNotifications/);
});
