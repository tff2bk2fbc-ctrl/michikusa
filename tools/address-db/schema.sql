PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS address_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS address_prefectures (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS address_municipalities (
  id INTEGER PRIMARY KEY,
  prefecture_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  UNIQUE(prefecture_id, name)
);

CREATE TABLE IF NOT EXISTS address_towns (
  id INTEGER PRIMARY KEY,
  municipality_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  locality TEXT NOT NULL DEFAULT '',
  UNIQUE(municipality_id, name, locality)
);

CREATE TABLE IF NOT EXISTS address_points (
  id INTEGER PRIMARY KEY,
  town_id INTEGER NOT NULL,
  block TEXT NOT NULL DEFAULT '',
  lat_e6 INTEGER NOT NULL,
  lng_e6 INTEGER NOT NULL,
  grid_lat INTEGER NOT NULL,
  grid_lng INTEGER NOT NULL
);

-- デジタル庁ABRの正式名称・全国共通ID。元の国交省名称は保持して安全に差し替える。
CREATE TABLE IF NOT EXISTS address_town_registry (
  town_id INTEGER PRIMARY KEY,
  lg_code TEXT NOT NULL,
  machiaza_id TEXT NOT NULL,
  official_name TEXT NOT NULL,
  post_code TEXT NOT NULL DEFAULT '',
  status_flg TEXT NOT NULL DEFAULT ''
);

-- 街区符号・住居番号・地番の全国正式版が公開されたときに投入する予約スキーマ。
CREATE TABLE IF NOT EXISTS address_units (
  id TEXT PRIMARY KEY,
  lg_code TEXT NOT NULL,
  machiaza_id TEXT NOT NULL,
  block TEXT NOT NULL DEFAULT '',
  house_number TEXT NOT NULL DEFAULT '',
  building TEXT NOT NULL DEFAULT '',
  lat_e6 INTEGER,
  lng_e6 INTEGER,
  source TEXT NOT NULL,
  effective_date TEXT NOT NULL DEFAULT ''
);

-- 0.002度格子（日本付近で約180〜220m）。まず近傍9セルだけを読む。
CREATE INDEX IF NOT EXISTS address_points_grid
  ON address_points(grid_lat, grid_lng);
