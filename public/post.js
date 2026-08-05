/* ============================================================
   記録する
   ============================================================ */

/* ============================================================
   一度取り込んだ写真を覚えておく

   写真そのものに固有の番号は無いので、指紋を自分で作る。
   撮影日時＋座標で判別し、日時が無いものはファイルの中身から作る。
   ============================================================ */
function fingerprint(lat,lng,at,file){
  if(at&&isFinite(lat)){
    return 'g'+Math.round(at/1000)+'_'+lat.toFixed(5)+'_'+lng.toFixed(5);
  }
  // 日時が取れない場合は、大きさと更新時刻で代用
  return 'f'+(file?file.size:0)+'_'+(file?(file.lastModified||0):0);
}
async function seenAdd(fp){ return dbPut('seen',{id:fp,at:Date.now()}); }
async function seenHas(fp){
  return new Promise(function(r){
    if(!db)return r(false);
    try{
      var q=db.transaction('seen','readonly').objectStore('seen').get(fp);
      q.onsuccess=function(){ r(!!q.result); };
      q.onerror=function(){ r(false); };
    }catch(e){ r(false); }
  });
}

/* ============================================================
   カメラロールからまとめて取り込む

   写真には撮った場所と日時が埋まっている。
   それを読めば、選ぶだけで地図が埋まる。
   1枚ずつ記録させると続かないので、ここが要になる。
   ============================================================ */
function readAsData(file){
  return new Promise(function(res){
    var r=new FileReader();
    r.onload=function(){res(r.result);};
    r.onerror=function(){res(null);};
    r.readAsDataURL(file);
  });
}

document.getElementById('btn-bulk').onclick=async function(){
  var got=await pickPhotos();
  if(got===null)return;              // ブラウザなら入力欄が開く
  if(!got.length){ setTip('選ばれませんでした'); return; }
  // Capacitorから来たものは、読み込んでからいつもの流れへ
  var files=[];
  for(var i=0;i<got.length;i++){
    try{
      var r=await fetch(got[i].webPath||got[i].path);
      var b=await r.blob();
      files.push(new File([b],'p'+i+'.jpg',{type:b.type||'image/jpeg'}));
    }catch(e){}
  }
  if(!files.length){ setTip('写真を読めませんでした'); return; }
  handleBulk(files);
};

document.getElementById('in-bulk').onchange=function(e){
  var files=Array.prototype.slice.call(e.target.files||[]);
  e.target.value='';
  handleBulk(files);
};

async function handleBulk(files){
  if(!files.length)return;
  setTip('準備しています…');
  await need('exifr');
  if(typeof exifr==='undefined'){ setTip('写真を読む部品がありません'); return; }

  var s=showSheet('<div class="grab"></div><div class="pad" style="padding-top:18px">'+
    '<div style="font-size:18px;font-weight:700;margin-bottom:6px">写真を読んでいます</div>'+
    '<div id="bmsg" style="font-size:13px;color:var(--dim);line-height:1.9">'+
      files.length+' 枚を調べています…</div>'+
    '<div id="blist" style="margin-top:14px"></div>'+
    '<div id="bfoot"></div></div>');
  var msg=s.querySelector('#bmsg'), foot=s.querySelector('#bfoot');

  var found=[], noGeo=0, already=0;
  for(var i=0;i<files.length;i++){
    msg.textContent=(i+1)+' / '+files.length+' 枚を調べています…';
    var f=files[i];
    try{
      var g=await exifr.gps(f).catch(function(){return null;});
      if(!g||g.latitude==null){ noGeo++; continue; }
      var pp=await exifr.parse(f,{pick:['DateTimeOriginal','CreateDate']}).catch(function(){return null;});
      var dt=pp&&(pp.DateTimeOriginal||pp.CreateDate);
      var at=dt?new Date(dt).getTime():(f.lastModified||Date.now());
      var fp=fingerprint(g.latitude,g.longitude,dt?at:null,f);
      if(await seenHas(fp)){ already++; continue; }   // もう入れたもの
      found.push({file:f,lat:g.latitude,lng:g.longitude,fp:fp,
        d:dt?new Date(dt).toISOString().slice(0,10):'', at:at});
    }catch(err){ noGeo++; }
  }

  if(!found.length){
    if(already&&!noGeo){
      msg.innerHTML='<b>'+already+' 枚</b>は、すでに地図に入っています。<br>'+
        '<span style="font-size:12px">新しく入れるものはありませんでした。</span>';
      foot.innerHTML='<button class="btn g" id="x" style="margin-top:16px">とじる</button>';
      foot.querySelector('#x').onclick=closeSheet;
      return;
    }
    msg.innerHTML='位置情報のある写真が見つかりませんでした。<br>'+
      '<span style="font-size:12px">iPhoneなら「設定 → プライバシーとセキュリティ → '+
      '位置情報サービス → カメラ」をオンにしてください。</span>';
    foot.innerHTML='<button class="btn g" id="x" style="margin-top:16px">とじる</button>';
    foot.querySelector('#x').onclick=closeSheet;
    return;
  }

  // 近くて時間も近いものを、ひとつの場所にまとめる
  found.sort(function(a,b){return a.at-b.at;});
  var groups=[];
  found.forEach(function(p){
    var g=groups[groups.length-1];
    if(g){
      var d=Math.hypot((p.lat-g.lat)*111000,(p.lng-g.lng)*91000);
      var dt=Math.abs(p.at-g.at)/3600000;
      if(d<120&&dt<3){ g.items.push(p); return; }
    }
    groups.push({lat:p.lat,lng:p.lng,at:p.at,d:p.d,items:[p]});
  });

  msg.innerHTML='<b>'+found.length+' 枚</b>から <b>'+groups.length+' か所</b>が見つかりました。'+
    (noGeo?('<br><span style="font-size:12px">位置情報のない '+noGeo+' 枚は除きました。</span>'):'')+
    (already?('<br><span style="font-size:12px">すでに入っている '+already+' 枚は飛ばしました。</span>'):'');

  var list=s.querySelector('#blist');
  list.innerHTML='<div style="font-size:12px;color:var(--dim)">場所を調べています…</div>';
  for(var k=0;k<groups.length;k++){
    var r=await revGeo(groups[k].lat,groups[k].lng);
    groups[k].place=r.name;
    groups[k].name=(r.near&&r.near.n)||r.name;
    groups[k].cat=(r.near&&r.near.c)||'景';
  }

  list.innerHTML=groups.map(function(g,i){
    return '<div class="post" style="align-items:center">'+
      '<div class="av2" id="bth'+i+'"></div>'+
      '<div class="b"><b>'+esc(g.name)+'</b>'+
      '<span>'+esc(g.d||'')+' ・ '+g.items.length+'枚</span></div>'+
      '<button class="chip on" data-skip="'+i+'" style="flex:0 0 auto">入れる</button></div>';
  }).join('');

  groups.forEach(function(g,i){
    var r2=new FileReader();
    r2.onload=function(){
      var e2=document.getElementById('bth'+i);
      if(e2)e2.style.backgroundImage='url('+JSON.stringify(r2.result)+')';
    };
    r2.readAsDataURL(g.items[0].file);
  });

  var skip={};
  Array.prototype.forEach.call(list.querySelectorAll('[data-skip]'),function(b){
    b.onclick=function(){
      var i=b.dataset.skip;
      skip[i]=!skip[i];
      b.classList.toggle('on',!skip[i]);
      b.textContent=skip[i]?'入れない':'入れる';
    };
  });

  foot.innerHTML='<button class="btn" id="go" style="margin-top:16px">'+
      'この '+groups.length+' か所を地図に置く</button>'+
    '<button class="btn g" id="x" style="margin-top:8px">やめる</button>';
  foot.querySelector('#x').onclick=closeSheet;

  foot.querySelector('#go').onclick=async function(){
    var btn=this; btn.disabled=true;
    var use=groups.filter(function(g,i){return !skip[i];});
    var done=0;
    for(var i=0;i<use.length;i++){
      var g=use[i];
      btn.textContent=(i+1)+' / '+use.length+' を置いています…';
      var url=await readAsData(g.items[0].file);
      var rec={id:nid(),n:g.name,c:g.cat,lat:g.lat,lng:g.lng,place:g.place||'',
        tag:'',d:g.d||new Date(g.at).toISOString().slice(0,10),photo:url||''};
      spots.push(rec);
      await dbPut('spots',rec);
      for(var q=0;q<g.items.length;q++){ if(g.items[q].fp) await seenAdd(g.items[q].fp); }
      if(fbUser) pushOne(rec);
      done++;
    }
    closeSheet(); render(true);
    setTip(done+' か所を地図に置きました');
    if(use.length) map.easeTo({center:[use[0].lng,use[0].lat],zoom:16.6,duration:900});
  };
}

function openAdd(p){
  var cat=p.cat||CATS[0];
  var tagged=[];        // 一緒にいた人

  /* 聞くことを絞る。場所も日付も写真から分かるので、聞かない */
  var html='<div class="grab"></div>'+
    (p.photo?'<div class="pv-wrap">'+
      '<img src="'+p.photo+'">'+
      '<button class="pv-btn" id="tag-btn">'+
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9">'+
        '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7"/></svg>'+
      '</button>'+
      '<span class="pv-cnt" id="tag-cnt" style="display:none"></span>'+
    '</div>':'')+
    '<div class="pad">'+
      '<div style="font-size:18px;font-weight:700;line-height:1.4;margin-bottom:3px">'+
        esc(p.known||p.place||'この場所')+'</div>'+
      '<div style="font-size:12.5px;color:var(--dim);margin-bottom:16px">'+
        esc([p.place&&p.place!==p.known?p.place:'', p.date||'いま']
          .filter(Boolean).join('　'))+'</div>'+
      (!p.known?'<input class="fld" id="f-n" placeholder="場所の名前">':'')+
      '<input class="fld" id="f-t" placeholder="キャプションを追加…">'+
      '<div class="chips" id="sug" style="margin:-2px 0 12px;display:none"></div>'+
      (!p.photo?'<div class="photorow">'+
        '<label class="pick" id="p1"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M3 7.5h4L8.5 5.5h7L17 7.5h4v12H3z"/><circle cx="12" cy="13" r="3.6"/></svg><span>撮る</span></label>'+
        '<label class="pick" id="p2"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M3 5.5h18v13H3z"/><path d="M3 15l5-4 4 3 3-3 6 5"/></svg><span>カメラロール</span></label>'+
      '</div>':'')+
      '<button class="btn" id="ok">ここに残す</button>'+
      '<button class="btn g" id="ng" style="margin-top:8px">やめる</button>'+
    '</div>';

  var s=showSheet(html);
  var ft=s.querySelector('#f-t');
  var nm=s.querySelector('#f-n');
  var ok=s.querySelector('#ok');

  function sync(){ ok.disabled = nm ? !nm.value.trim() : false; }
  if(nm) nm.oninput=sync;
  sync();

  s.querySelector('#ng').onclick=closeSheet;
  var p1=s.querySelector('#p1'), p2=s.querySelector('#p2');
  if(p1) p1.onclick=function(){ closeSheet(); document.getElementById('in-cam').click(); };
  if(p2) p2.onclick=function(){ closeSheet(); document.getElementById('in-lib').click(); };

  /* 写真から、ひとことの候補を出してもらう */
  (function(){
    if(!p.photo)return;
    var box=s.querySelector('#sug'); if(!box)return;
    if(String(p.photo).length>3000000)return;
    api('/api/suggest',{method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({image:String(p.photo),category:cat})})
      .then(function(r){return r.json();})
      .then(function(j){
        var items=(j&&j.items)||[];
        if(!items.length)return;
        box.innerHTML=items.map(function(t){
          return '<button class="chip" data-t="'+esc(t)+'">'+esc(t)+'</button>';
        }).join('');
        box.style.display='flex';
        Array.prototype.forEach.call(box.querySelectorAll('.chip'),function(b){
          b.onclick=function(){ ft.value=b.dataset.t; ft.focus(); };
        });
      }).catch(function(){});
  })();

  /* 一緒にいた人を選ぶ */
  var tb=s.querySelector('#tag-btn'), tc=s.querySelector('#tag-cnt');
  function showCount(){
    if(!tc)return;
    if(tagged.length){ tc.style.display='block'; tc.textContent=tagged.length+'人';
      tb.classList.add('has'); }
    else { tc.style.display='none'; tb.classList.remove('has'); }
  }
  if(tb) tb.onclick=function(){
    openTagPicker(tagged,function(sel){ tagged=sel; showCount(); });
  };

  ok.onclick=function(){
    var rec={id:nid(),n:(nm?nm.value.trim():p.known)||p.place||'この場所',
      c:cat,lat:p.lat,lng:p.lng,place:p.place||'',
      tag:ft.value.trim(),d:p.date||new Date().toISOString().slice(0,10),
      photo:p.photo||'', tagged:tagged.map(function(u){return u.id;})};
    spots.push(rec); dbPut('spots',rec);
    if(p.fp) seenAdd(p.fp);
    closeSheet(); render(true); setTip('残しました');
    if(fbUser) pushOne(rec).then(function(o){
      if(o&&rec.server_id&&tagged.length){
        api('/api/tags',{method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({post_id:rec.server_id,
            user_ids:tagged.map(function(u){return u.id;})})}).catch(function(){});
      }
      if(o)render(true);
    });
  };
  if(!p.known&&!p.photo&&nm) setTimeout(function(){nm.focus();},340);
}

/* ============================================================
   友達をタグ付け
   ============================================================ */
async function openTagPicker(current, done){
  if(!fbUser){ setTip('ログインが必要です'); return; }
  var sel=(current||[]).slice();

  var s=showSheet('<div class="grab"></div>'+
    '<div class="tg-head"><span style="width:56px"></span>'+
    '<b>友達をタグ付け</b>'+
    '<button id="tg-ok">完了</button></div>'+
    '<div class="pad"><input class="fld" id="tg-q" placeholder="友達を探す"></div>'+
    '<div id="tg-list" style="padding-bottom:22px">'+
      '<div style="padding:18px 16px;font-size:13px;color:var(--dim)">読み込んでいます…</div>'+
    '</div>');

  var list=s.querySelector('#tg-list');
  var r=await api('/api/friends');
  var friends=[];
  if(r.ok){ var j=await r.json(); friends=j.friends||[]; }

  function draw(q){
    var f=friends.filter(function(u){
      if(!q)return true;
      return (u.display_name||'').indexOf(q)>=0 || (u.handle||'').indexOf(q)>=0;
    });
    if(!f.length){
      list.innerHTML='<div style="padding:22px 16px;text-align:center;'+
        'font-size:13px;color:var(--dim);line-height:1.9">'+
        (friends.length?'見つかりません':'まだフレンドがいません。<br>'+
        'アカウントからIDを交換してください。')+'</div>';
      return;
    }
    list.innerHTML=f.map(function(u){
      var on=sel.some(function(x){return x.id===u.id;});
      var nm=u.display_name||u.handle||'';
      return '<div class="tg-row" data-id="'+esc(u.id)+'">'+
        '<div class="av">'+esc(nm.charAt(0))+'</div>'+
        '<div class="nm"><b>'+esc(nm)+'</b><span>@'+esc(u.handle||'')+'</span></div>'+
        '<button class="pick'+(on?' on':'')+'">'+(on?'解除':'タグ付け')+'</button></div>';
    }).join('');
    Array.prototype.forEach.call(list.querySelectorAll('.tg-row'),function(row){
      row.querySelector('.pick').onclick=function(){
        var id=row.dataset.id;
        var i=sel.findIndex(function(x){return x.id===id;});
        if(i>=0) sel.splice(i,1);
        else {
          var u=friends.filter(function(x){return x.id===id;})[0];
          if(u) sel.push(u);
        }
        draw(s.querySelector('#tg-q').value.trim());
      };
    });
  }
  draw('');
  s.querySelector('#tg-q').oninput=function(){ draw(this.value.trim()); };
  s.querySelector('#tg-ok').onclick=function(){ closeSheet(); done(sel); };
}
