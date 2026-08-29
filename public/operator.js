/* ============================================================
   運営者だけの急上昇ワード編集

   入口の非表示は補助であり、権限の根拠ではない。
   APIごとにWorkerがFirebase UIDをD1許可リストと照合している。
   ============================================================ */
(function(){
  var editorCache=null;

  function today(){return new Date().toISOString().slice(0,10);}
  function make(tag,className,text){
    var node=document.createElement(tag);if(className)node.className=className;
    if(text!==undefined)node.textContent=text;return node;
  }

  function cleanTerms(value){
    return (Array.isArray(value)?value:[]).filter(function(term){
      return term&&typeof term.label==='string'&&typeof term.query==='string';
    }).slice(0,3);
  }

  async function readOperatorTerms(force){
    var auth=await captureAuth();if(!auth)return null;
    if(!force&&editorCache&&editorCache.uid===auth.uid)return {auth:auth,terms:editorCache.terms};
    var response=await apiAs(auth,'/api/admin/map-trends',{headers:{'Accept':'application/json'}});
    if(response.status===401||response.status===403)return null;
    var data=await response.json().catch(function(){return {};});
    if(!response.ok)throw new Error(data.error||'運営者データを読み込めませんでした');
    var terms=cleanTerms(data.terms);editorCache={uid:auth.uid,terms:terms};
    return {auth:auth,terms:terms};
  }

  function appendField(card,name,label,value,options){
    var field=make('label','operator-trend-field'),caption=make('span','',label),input=document.createElement('input');
    input.name=name;input.value=value||'';input.autocomplete='off';input.maxLength=options.maxLength;
    if(options.type)input.type=options.type;if(options.placeholder)input.placeholder=options.placeholder;
    field.append(caption,input);card.appendChild(field);return input;
  }

  function addTrendCard(list,index,term){
    var card=make('section','operator-trend-card'),head=make('div','operator-trend-card-head');
    head.append(make('b','',String(index+1).padStart(2,'0')),make('span','','空欄にするとこの枠は非表示'));
    card.appendChild(head);
    appendField(card,'label','地図に表示する言葉',term&&term.label,{maxLength:48,placeholder:'例：奥日光'});
    appendField(card,'query','タップ時に検索する言葉',term&&term.query,{maxLength:80,placeholder:'例：奥日光'});
    appendField(card,'observed_on','確認日',term&&term.observed_on||today(),{maxLength:10,type:'date'});
    appendField(card,'source_label','確認元',term&&term.source_label||'Google Trends 手動確認',{maxLength:48,placeholder:'例：Google Trends 手動確認'});
    list.appendChild(card);
  }

  function valuesFrom(form){
    return Array.prototype.map.call(form.querySelectorAll('.operator-trend-card'),function(card){
      var read=function(name){var input=card.querySelector('[name="'+name+'"]');return input?input.value.trim():'';};
      var label=read('label'),query=read('query');
      // 空き枠には確認日が初期表示されていても、サーバーへは空き枠として送る。
      if(!label&&!query)return {label:'',query:'',observed_on:'',source_label:''};
      return {label:label,query:query,observed_on:read('observed_on'),source_label:read('source_label')};
    });
  }

  function notifyMap(terms){
    window.dispatchEvent(new CustomEvent('spota:map-trends-updated',{detail:{terms:terms}}));
  }

  function buildDashboard(screen,initial){
    var body=screen.querySelector('.release-body');body.replaceChildren();
    var section=make('section','operator-trends'),head=make('header','operator-trends-head'),kicker=make('p','operator-kicker','Map desk');
    head.append(kicker,make('h1','','急上昇ワード'),make('p','','地図の検索欄の上に、手動で確認した最大3件を表示します。自動取得は行いません。'));
    var form=document.createElement('form'),fieldset=document.createElement('fieldset'),legend=make('legend','','公開する言葉'),note=make('p','operator-trend-note','表示名をタップすると、指定した検索語で地図を検索します。すべて空欄にすると、急上昇ワード帯を非表示にします。'),list=make('div','operator-trend-list');
    form.className='operator-trend-form';form.noValidate=true;fieldset.append(legend,note,list);
    for(var i=0;i<3;i++)addTrendCard(list,i,initial[i]||null);
    var actions=make('div','operator-trend-form-actions'),status=make('p','operator-trend-status','');
    status.id='operator-trend-status';status.setAttribute('role','status');status.setAttribute('aria-live','polite');
    var save=make('button','operator-trend-save','地図へ公開');save.type='submit';save.setAttribute('aria-describedby',status.id);
    actions.append(status,save,make('p','operator-trend-help','保存履歴には、運営者UID・変更件数・時刻だけを記録します。一般ユーザーには表示名と検索語だけが公開されます。'));
    form.append(fieldset,actions);section.append(head,form);body.appendChild(section);

    form.addEventListener('submit',async function(event){
      event.preventDefault();status.classList.remove('is-error');status.textContent='公開内容を保存しています…';save.disabled=true;
      try{
        var auth=await captureAuth();if(!auth)throw new Error('ログインを確認できませんでした');
        var response=await apiAs(auth,'/api/admin/map-trends',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({terms:valuesFrom(form)})});
        var data=await response.json().catch(function(){return {};});
        if(!response.ok)throw new Error(data.error||'保存できませんでした');
        var terms=cleanTerms(data.terms);editorCache={uid:auth.uid,terms:terms};notifyMap(terms);
        status.textContent=terms.length?'地図の急上昇ワードを更新しました。':'急上昇ワード帯を非表示にしました。';
      }catch(error){status.classList.add('is-error');status.textContent=error&&error.message||'保存できませんでした';}
      finally{save.disabled=false;}
    });
  }

  async function openDashboard(){
    try{
      var current=await readOperatorTerms(true);
      if(!current){setTip('運営者権限を確認できませんでした');return;}
      var screen=makeReleaseScreen('急上昇ワード');buildDashboard(screen,current.terms);
    }catch(error){setTip(error&&error.message||'運営者画面を開けませんでした');}
  }

  async function mountTrendOperatorEntry(sheet){
    var slot=sheet&&sheet.querySelector('#trend-operator-entry');if(!slot)return;
    slot.replaceChildren();slot.hidden=true;
    try{
      var current=await readOperatorTerms(false);if(!current||!slot.isConnected)return;
      var area=make('section','operator-entry'),title=make('div','me-section','運営者'),button=make('button','me-row');
      button.type='button';button.append(make('b','','急上昇ワード'),make('small','','地図の上部を編集　›'));
      button.onclick=function(){if(typeof closeSheet==='function')closeSheet();openDashboard();};
      area.append(title,button);slot.appendChild(area);slot.hidden=false;
    }catch(_){/* 通常ユーザーや一時的な通信失敗では入口を表示しない。 */}
  }

  window.mountTrendOperatorEntry=mountTrendOperatorEntry;
  window.addEventListener('spota:map-trends-updated',function(event){
    if(typeof drawMapTrends==='function')drawMapTrends(event.detail&&event.detail.terms);
  });
})();
