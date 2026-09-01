import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../public/native.js", import.meta.url), "utf8");
const postSource = readFileSync(new URL("../public/post.js", import.meta.url), "utf8");
const mapSource = readFileSync(new URL("../public/map.js", import.meta.url), "utf8");
const workerSource = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
const staticHeaders = readFileSync(new URL("../public/_headers", import.meta.url), "utf8");

function nodeStub() {
  return {
    classList: { add() {}, remove() {}, toggle() {} },
    style: {},
    click() {},
    textContent: "",
  };
}

function loadNative(cameraResult, modernCamera) {
  const nodes = new Map();
  const placements = [];
  let cameraOptions = null;
  const context = {
    window: {
      Capacitor: {
        isNativePlatform: () => true,
        Plugins: {
          Camera: modernCamera || {
            getPhoto: async (options) => {
              cameraOptions = options;
              return cameraResult;
            },
          },
        },
      },
    },
    document: {
      body: { classList: { add() {}, remove() {}, toggle() {} } },
      getElementById(id) {
        if (!nodes.has(id)) nodes.set(id, nodeStub());
        return nodes.get(id);
      },
      createElement: nodeStub,
    },
    navigator: {},
    map: { getCenter: () => ({ lat: 35, lng: 139 }) },
    startPlacing(lat, lng, options) { placements.push({ lat, lng, options }); },
    showSheet() {
      return { querySelector(selector) {
        const id = String(selector).replace(/^#/, "");
        if (!nodes.has(id)) nodes.set(id, nodeStub());
        return nodes.get(id);
      } };
    },
    closeSheet() {},
    setTip() {},
    need: async () => true,
    exifr: { gps: async () => null, parse: async () => null },
    setTimeout,
    clearTimeout,
    FileReader: class {},
    fetch,
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  context.cameraOptions = () => cameraOptions;
  context.nodes = nodes;
  context.placements = placements;
  return context;
}

test("ネイティブ写真はdata URLで受け取りEXIFを保持する", async () => {
  const exif = { GPS: { Latitude: 35.6812, Longitude: 139.7671 } };
  const context = loadNative({ dataUrl: "data:image/jpeg;base64,AA==", exif });
  const result = await context.pickPhoto(false);

  assert.equal(context.cameraOptions().resultType, "dataUrl");
  assert.equal(context.cameraOptions().source, "PHOTOS");
  assert.equal(context.cameraOptions().width, 4096);
  assert.equal(context.cameraOptions().height, 4096);
  assert.equal(result.dataUrl, "data:image/jpeg;base64,AA==");
  assert.deepEqual(result.exif, exif);
});

test("GPSなしを座標0,0として扱わない", () => {
  const context = loadNative(null);
  assert.equal(context.validPhotoGps(null), false);
  assert.equal(context.validPhotoGps({ latitude: null, longitude: null }), false);
  assert.equal(context.validPhotoGps({ latitude: 0, longitude: 0 }), true);
});

test("Capacitor EXIFの緯度経度を読み取る", () => {
  const context = loadNative(null);
  const gps = context.gpsFromNativeExif({
    GPS: {
      Latitude: [35, 40, 52.32],
      Longitude: [139, 46, 1.56],
      LatitudeRef: "N",
      LongitudeRef: "E",
    },
  });
  assert.equal(gps.lat, 35.6812);
  assert.equal(gps.lng, 139.7671);
});

test("カメラ撮影後に写真追加フローへ進む", async () => {
  const context = loadNative({ dataUrl: "data:image/jpeg;base64,CAMERA", exif: {} });
  await context.nodes.get("btn-cam").onclick();

  assert.equal(context.cameraOptions().source, "CAMERA");
  assert.equal(context.placements.length, 1);
  assert.equal(context.placements[0].options.photo, "data:image/jpeg;base64,CAMERA");
  assert.equal(context.placements[0].options.manualPhotoLocation, true);
});

test("ライブラリ選択後に写真追加フローへ進む", async () => {
  const context = loadNative({ dataUrl: "data:image/jpeg;base64,LIBRARY", exif: {} });
  await context.nodes.get("btn-lib").onclick();

  assert.equal(context.cameraOptions().source, "PHOTOS");
  assert.equal(context.placements.length, 1);
  assert.equal(context.placements[0].options.photo, "data:image/jpeg;base64,LIBRARY");
  assert.equal(context.placements[0].options.manualPhotoLocation, true);
});

test("ネイティブmetadataが空でも画像本体の隠れたGPSを再解析する", async () => {
  const context = loadNative({ dataUrl: "data:image/jpeg;base64,HIDDEN", exif: {} });
  context.exifr.gps = async () => ({ latitude: 35.6586, longitude: 139.7454 });
  await context.nodes.get("btn-lib").onclick();
  assert.equal(context.placements.length, 0, "GPS確認シートの選択前には配置しない");
  const yes = context.nodes.get("photo-gps-yes");
  assert.ok(yes && typeof yes.onclick === "function");
  yes.onclick();
  assert.equal(context.placements[0].lat, 35.6586);
  assert.equal(context.placements[0].lng, 139.7454);
  assert.equal(context.placements[0].options.photoGps, true);
});

test("Capacitor 8の現行ライブラリAPIから新規写真を追加できる", async () => {
  let options;
  const context = loadNative(null, {
    takePhoto: async () => { throw new Error("unused"); },
    chooseFromGallery: async (received) => {
      options = received;
      return { results: [{
        dataUrl: "data:image/jpeg;base64,MODERN",
        metadata: { creationDate: "2026-08-15T10:00:00Z", exif: {} },
      }] };
    },
  });

  await context.nodes.get("btn-lib").onclick();
  assert.equal(options.allowMultipleSelection, false);
  assert.equal(options.targetWidth, 4096);
  assert.equal(options.targetHeight, 4096);
  assert.equal(options.includeMetadata, true);
  assert.equal(context.placements.length, 1);
  assert.equal(context.placements[0].options.photo, "data:image/jpeg;base64,MODERN");
  assert.equal(context.placements[0].options.date, "2026-08-15");
});

test("現行APIが失敗した端末では互換APIへ一度だけ退避する", async () => {
  let legacyOptions;
  const context = loadNative(null, {
    takePhoto: async () => { throw new Error("unused"); },
    chooseFromGallery: async () => { throw new Error("bridge unavailable"); },
    getPhoto: async (received) => {
      legacyOptions = received;
      return { dataUrl: "data:image/jpeg;base64,FALLBACK", exif: {} };
    },
  });

  await context.nodes.get("btn-lib").onclick();
  assert.equal(legacyOptions.source, "PHOTOS");
  assert.equal(context.placements[0].options.photo, "data:image/jpeg;base64,FALLBACK");
});

test("追加シート内の撮影とライブラリもネイティブ経路を使う", () => {
  assert.match(postSource, /chooseSinglePhoto\(true\)/);
  assert.match(postSource, /chooseSinglePhoto\(false\)/);
});

test("Capacitor画像URLをCSPが遮断しない", () => {
  assert.match(workerSource, /connect-src 'self' capacitor:/);
  assert.match(staticHeaders, /connect-src 'self' capacitor:/);
  assert.match(source, /sourceUrl\.origin!==location\.origin/);
});

test("一括取込でネイティブEXIFを保持する", () => {
  assert.match(postSource, /__spotaExif/);
  assert.match(postSource, /candidateExif\(source\)/);
  assert.match(postSource, /gpsFromNativeExif\(nativeExif\)/);
});

test("複数選択APIがdata URLを返す端末でも0枚にしない", () => {
  assert.match(postSource, /dataUrl:photo\.dataUrl\|\|''/);
  assert.match(postSource, /c\.asset\|\|c\.dataUrl/);
  assert.match(postSource, /if\(candidate\.dataUrl\)/);
  assert.match(postSource, /new File\(\[bytes\]/);
});

test("一括取込もCapacitor 8の現行複数選択APIを使う", async () => {
  let options;
  const context = loadNative(null, {
    chooseFromGallery: async (received) => {
      options = received;
      return { results: [{ webPath: "https://localhost/_capacitor_file_/one.jpg", metadata: { exif: "{}" } }] };
    },
  });
  const photos = await context.pickPhotos();
  assert.equal(options.allowMultipleSelection, true);
  assert.equal(options.limit, 200);
  assert.equal(options.includeMetadata, true);
  assert.equal(photos.length, 1);
  assert.equal(photos[0].webPath, "https://localhost/_capacitor_file_/one.jpg");
});

test("一括追加は0枚を成功表示せず、候補ファイルの再読込をキャッシュする", () => {
  assert.match(postSource, /candidate\.file=f/);
  assert.match(postSource, /photoForLocalStorage\(url\)/);
  assert.match(postSource, /photoForLocalStorage\(p\.photo\|\|''\)/);
  assert.match(postSource, /if\(!done\)/);
  assert.doesNotMatch(postSource, /setTip\(done\+'枚を '\+donePlaces\+'か所に置きました'\);/);
  assert.match(postSource, /putSpotWithStorageRecovery\(rec\)/);
  assert.match(postSource, /compactSyncedPhotos/);
  assert.match(postSource, /id="bulk-vis"/);
  assert.match(postSource, /visibility:bulkVisibility/);
  assert.doesNotMatch(postSource, /visibility:defaultPostVisibility\(\),owner_scope:workScope/);
});

test("共有地図からの写真追加は全経路で公開範囲の明示選択を要求する", () => {
  assert.match(postSource, /function initialPostVisibility\(\)/);
  assert.match(postSource, /mapAudience==='public'[\s\S]{0,30}\?null:defaultPostVisibility\(\)/);
  assert.match(postSource, /var bulkVisibility=initialPostVisibility\(\)/);
  assert.match(postSource, /var chosenVisibility=initialPostVisibility\(\)/);
  assert.match(postSource, /\['public','みんな'\]/);
  assert.match(postSource, /go\.disabled=!value/);
  assert.match(postSource, /ok\.disabled = !chosenVisibility/);
  assert.match(postSource, /みんなの地図へ公開/);
  assert.match(postSource, /settings\.public_precision\|\|'approx'/);
});

test("端末保存はIndexedDBトランザクション確定後だけ成功になる", () => {
  const core = readFileSync(new URL("../public/core.js", import.meta.url), "utf8");
  const start = core.indexOf("function dbPut");
  const end = core.indexOf("function dbFailureReason", start);
  const put = core.slice(start, end);
  assert.match(put, /transaction\.oncomplete/);
  assert.match(put, /transaction\.onabort=fail/);
  assert.doesNotMatch(put, /\.onsuccess=function\(\)\{r\(true\)/);
});

test("サーバー保存済み写真だけ端末サムネイルへ整理する", () => {
  const sync = readFileSync(new URL("../public/sync.js", import.meta.url), "utf8");
  assert.match(sync, /rec\.photo_synced!==1/);
  assert.match(sync, /!rec\.server_photo_id/);
  assert.match(sync, /rec\.photo=thumb;rec\.photo_is_thumb=1/);
  assert.match(sync, /if\(rec\.photo&&!rec\.photo_synced\)/);
});

test("自分の地図は3枚目より後のサーバー写真も復元キューへ入れる", () => {
  const sync = readFileSync(new URL("../public/sync.js", import.meta.url), "utf8");
  assert.doesNotMatch(sync, /photoLoads<3/);
  assert.match(sync, /restoreQueue\.length>=40/);
  assert.match(sync, /while\(restoring<2&&restoreQueue\.length\)/);
});

test("スワイプは日次候補だけに使い、意図的な選択は直接追加する", () => {
  assert.match(postSource, /secureShuffle\(candidates\)/);
  assert.match(postSource, /右へ USE・左へ PASS/);
  assert.match(postSource, /if\(use\)kept\.push\(candidate\)/);
  assert.doesNotMatch(postSource, /kept\.push\(await chosenCandidateFile/);
  assert.match(postSource, /releaseScreen!==screen/);
  assert.match(postSource, /function chooseAlbumPhotos\(\)[\s\S]*handleBulk\(candidates\)/);
  assert.match(postSource, /getElementById\('in-bulk'\)[\s\S]*handleBulk\(files\.map/);
  assert.match(postSource, /openMemoryDeck\(\[\{asset:candidate\.dataUrl[\s\S]*daily:true/);
  assert.match(postSource, /if\(!use\)discardDaily\(Daily,item\)/);
  assert.match(postSource, /onClose:function\(finished\)\{if\(!finished\)discardDaily\(Daily,candidate\)/);
  assert.match(postSource, /await Daily\.photo\(\{id:item\.dailyId\}\)/);
});

test("1日1枚は明示同意後のみ有効になり、不使用で送信しない", () => {
  assert.match(postSource, /status=await Daily\.requestAuthorization\(\)/);
  assert.match(postSource, /localStorage\.setItem\(DAILY_ENABLED,'1'\)/);
  const decisionStart = postSource.indexOf('onDecision:function');
  const keepStart = postSource.indexOf('onKeep:async function', decisionStart);
  assert.ok(decisionStart > 0 && keepStart > decisionStart);
  assert.doesNotMatch(postSource.slice(decisionStart, keepStart), /api\(|fetch\(|Daily\.photo/);
  assert.doesNotMatch(postSource, /randomCandidate\(\{exclude:/);
  assert.doesNotMatch(postSource, /function dailySeen|function rememberDaily/);
});

test("日次写真の準備失敗は2時間後へ再予約し、読めない候補はnative側で飛ばす", () => {
  const plugin = readFileSync(new URL("../native/ios/DailyPhotoPlugin.swift", import.meta.url), "utf8");
  assert.match(postSource, /function retryDaily\(plan\)[\s\S]*2\*60\*60\*1000[\s\S]*scheduleDailyCheck\(\)/);
  assert.match(postSource, /Daily\.photo\([\s\S]{0,500}catch\(e\)\{retryDaily\(plan\)/);
  assert.match(plugin, /skipUnavailableCandidateLocked\(assetIdentifier:/);
  assert.match(plugin, /rememberAssetLocked\(assetIdentifier\)/);
  assert.match(plugin, /skipUnavailableCandidateLocked\(assetIdentifier: chosen\.localIdentifier, token: token\)/);
});

test("小規模ライブラリを一巡した翌日は直近1枚を避けて新しい候補巡回を始める", () => {
  const plugin = readFileSync(new URL("../native/ios/DailyPhotoPlugin.swift", import.meta.url), "utf8");
  assert.match(plugin, /if chosen == nil, visibleCount > 0/);
  assert.match(plugin, /retainedRecentAsset = visibleCount > 1 \? seenOrder\.first : nil/);
  assert.match(plugin, /asset\.localIdentifier != retainedRecentAsset/);
  assert.match(plugin, /resetSeenCycle = chosen != nil/);
  assert.match(plugin, /defaults\.set\(retainedRecentAsset\.map \{ \[\$0\] \} \?\? \[\], forKey: StateKey\.seen\)/);
});

test("地図初期化はnative.jsの変数を読込前に直接参照しない", () => {
  assert.doesNotMatch(mapSource, /if\s*\(\s*!locDone/);
  assert.match(mapSource, /window\.__michikusaMapReady=true/);
  assert.match(mapSource, /typeof window\.requestInitialHome==='function'/);
});

test("native.jsは地図の準備完了前後どちらでも現在地取得を開始できる", () => {
  assert.match(source, /window\.requestInitialHome=requestInitialHome/);
  assert.match(source, /if\(window\.__michikusaMapReady\)requestInitialHome\(\)/);
});
