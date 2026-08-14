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

function loadNative(cameraResult) {
  const nodes = new Map();
  const placements = [];
  let cameraOptions = null;
  const context = {
    window: {
      Capacitor: {
        isNativePlatform: () => true,
        Plugins: {
          Camera: {
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
    setTip() {},
    setTimeout,
    clearTimeout,
    FileReader: class {},
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

test("Capacitor画像URLをCSPが遮断しない", () => {
  assert.match(workerSource, /connect-src 'self' capacitor:/);
  assert.match(staticHeaders, /connect-src 'self' capacitor:/);
});

test("一括取込でネイティブEXIFを保持する", () => {
  assert.match(postSource, /__spotaExif/);
  assert.match(postSource, /candidateExif\(source\)/);
  assert.match(postSource, /gpsFromNativeExif\(nativeExif\)/);
});

test("写真候補はランダム化し、原寸Blobをデッキ内へ溜めない", () => {
  assert.match(postSource, /secureShuffle\(candidates\)/);
  assert.match(postSource, /右へ使う・左へ使わない/);
  assert.match(postSource, /if\(use\)kept\.push\(candidate\)/);
  assert.doesNotMatch(postSource, /kept\.push\(await chosenCandidateFile/);
  assert.match(postSource, /releaseScreen!==screen/);
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
