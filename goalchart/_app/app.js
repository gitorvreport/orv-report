/* ---------- data model ---------- */
const DAY_W = 46, ROW_H = 46, HEAD_H = 54, BAR_H = 26, EPIC_H = 34;
const EPIC_COLORS = ["#2a78d6","#eb6834","#1baf7a","#eda100","#e87ba4","#008300","#4a3aa7","#e34948"];
function hexA(h,a){const n=parseInt(h.slice(1),16); return "rgba("+((n>>16)&255)+","+((n>>8)&255)+","+(n&255)+","+a+")";}
const STLABEL = {done:"완료", inprog:"진행중", review:"검수 요청", todo:"예정", risk:"기한 초과"};
// **화면에 적는 상태 이름은 Jira 것을 그대로 쓴다.** t.status 는 statusCategory 로 접은
// 값이라 '대기 중'이 '진행중'으로, '할 일'이 '예정'으로 둔갑한다 — 담당자가 자기 이슈를
// 못 알아보고, 착수도 안 한 일이 진행 중으로 보인다(실제로 17건이 그랬다).
// 단 'risk'(기한 초과)는 Jira 에 없는, 마감을 지나 차트가 붙인 값이다. 그때는 Jira 이름으로
// 덮지 않는다 — 덮으면 늦었다는 사실이 화면에서 사라진다.
function stLabel(t){
  if(!t) return "";
  if(t.status==="risk") return STLABEL.risk;
  return t.statusName || STLABEL[t.status] || t.status || "";
}
// Jira 상태가 '대기 중'인 작업. statusCategory 로는 '진행 중'과 구별되지 않아 통계가
// 부풀었다. HOLD_STATUS 는 아래 applyJiraIssues 곁에 있다(날짜 배치 규칙과 같은 표를 쓴다).
// **status==="inprog" 를 함께 본다.** 마감이 지난 '대기 중'은 차트가 risk 로 덮는데,
// 그 조건이 없으면 진행중에서 빼는 수(hold)와 실제 inprog 건수가 어긋나 카드 숫자가
// 음수 쪽으로 밀리고, 같은 작업이 '대기 중'과 '기한 초과'에 두 번 센다.
function isHold(t){ return !!(t && t.status==="inprog" && t.statusName && HOLD_STATUS[t.statusName]); }
// 마감이 지나도 '기한 초과'로 덮지 않는 상태들. 완료는 끝났고, 검수 요청은 작업이 끝나고
// 확인만 남았다 — 둘 다 '늦었다'보다 '지금 무엇이 필요한지'를 보여주는 편이 낫다.
const DONE_LIKE = {done:true, review:true};
const STICON  = {done:"✓", inprog:"◐", review:"◆", todo:"○", risk:"▲"};
const STVAR   = {done:"var(--done)", inprog:"var(--inprog)", review:"var(--review)", todo:"var(--todo)", risk:"var(--risk)"};

// 데이터는 같은 폴더의 data.json 에서 온다. 셸이 모든 차트에서 동일할 수 있는 이유가
// 이 상대경로다 — 차트 id 를 박지 않으므로 파일을 복사하는 것만으로 새 차트가 선다.
// no-cache 는 "캐시를 쓰되 서버에 바뀌었는지 물어본다" 는 뜻이다. no-store 와 달리
// 안 바뀌었으면 304 로 끝나 시트를 안 고친 날에도 매번 전체를 내려받지 않는다.
let state = null;
const DATA_URL = "./data.json";
function jiraUrl(key){return key ? (state.jiraBase + encodeURIComponent(key)) : null;}

/* ---------- date helpers ---------- */
function pd(s){const [y,m,d]=s.split("-").map(Number); return new Date(y,m-1,d);}
function iso(dt){return dt.getFullYear()+"-"+String(dt.getMonth()+1).padStart(2,"0")+"-"+String(dt.getDate()).padStart(2,"0");}
function addD(dt,n){const r=new Date(dt); r.setDate(r.getDate()+n); return r;}
function diffD(a,b){return Math.round((b-a)/86400000);}
function mondayOf(dt){const wd=(dt.getDay()+6)%7; return addD(dt,-wd);}
function todayMid(){const t=new Date(); return new Date(t.getFullYear(),t.getMonth(),t.getDate());}
const WD = ["일","월","화","수","목","금","토"];

function frame(){
  if(state.window && state.window.on && state.window.start && state.window.end){
    const start=pd(state.window.start), end=pd(state.window.end);
    return {start, end, days:Math.max(diffD(start,end)+1,1), windowed:true};
  }
  const ds=[...state.tasks.map(t=>pd(t.start)), ...state.tasks.map(t=>pd(t.end)), pd(state.deadline)];
  let mn=ds[0], mx=ds[0];
  ds.forEach(d=>{if(d<mn)mn=d; if(d>mx)mx=d;});
  const start=mondayOf(mn);
  let end=addD(mondayOf(mx),6);            // to Sunday of last week
  const days=diffD(start,end)+1;
  return {start,end,days,windowed:false};
}
function outOfWindow(f,t){
  const s=diffD(f.start,pd(t.start)), e=diffD(f.start,pd(t.end));
  return e<0 ? "before" : (s>f.days-1 ? "after" : null);
}

/* ---------- rendering ---------- */
// 표시 순서는 state.tasks 의 배열 위치 그 자체다. 별도 order 필드를 두지 않는다 —
// 새 작업은 push 로 맨 뒤에 붙고, 내보내기/불러오기가 순서를 그대로 왕복시킨다.
function ordered(){return [...state.tasks];}

function isBlocked(t){
  if(t.status==="done") return false;
  return (t.deps||[]).some(id=>{const p=state.tasks.find(x=>x.id===id); return p && p.status!=="done";});
}

// 에픽 여러 개를 한 스윔레인으로 묶는다(예: 컷씬 4개 → "[컷씬] 천인호·정희원").
// **t.epic 을 고쳐서 합치면 안 된다** — 갱신할 때마다 applyJiraIssues 가 Jira 의
// parent 로 도로 덮는다. 그래서 합치기는 '묶는 키'를 따로 두는 것으로 해결한다:
// t.epic 은 Jira 값 그대로 남고(행 상세·표는 진짜 소속을 계속 보여준다),
// 레인만 그룹 단위로 묶인다.
//
// 그룹 key 는 실제 에픽 키와 겹치면 안 된다 — 겹치면 그 에픽이 그룹에 흡수된다.
//
// 묶는 방법이 둘이다. `members` 는 **에픽 키** — 그 에픽의 작업이 통째로 들어온다.
// `issues` 는 **이슈 키** — 작업 하나만 제 에픽 레인에서 떼어 온다(상위 에픽은 그대로다).
// 두 종류를 한 목록에 섞으면 나중에 읽는 사람이 어느 쪽인지 알 수 없어 나눠 뒀다.
//
// **이슈 지정이 에픽 지정을 이긴다** — 좁은 지정이 넓은 지정을 덮는 게 상식적이고,
// 반대로 두면 에픽째 묶인 그룹에서 한 건만 빼내는 일이 아예 불가능해진다.
//
// 표가 작아서(그룹 몇 개 × 키 몇 개) 그냥 훑는다. 캐시를 두면 '불러오기'로 state 가
// 통째로 바뀔 때 낡은 표가 남을 수 있는데, 아낄 시간이 없는 곳에서 그 위험을 살 이유가 없다.
function epicGroupFor(t){
  const gs = (state && state.epicGroups) || [];
  const ik = (t && t.jira) || "";
  if(ik) for(let i=0;i<gs.length;i++){
    if((gs[i].issues||[]).indexOf(ik) !== -1) return gs[i];
  }
  const ek = (t && t.epic && t.epic.key) || "";
  for(let i=0;i<gs.length;i++){
    if((gs[i].members||[]).indexOf(ek) !== -1) return gs[i];
  }
  return null;
}

function epicKeyOf(t){
  const g = epicGroupFor(t);
  if(g) return g.key;
  return (t && t.epic && t.epic.key) || "__none__";
}

/* group selected issues by their parent epic; only chosen issues appear */
// 에픽 순서 = 배열에서 처음 등장한 순서(Map 의 삽입 순서). 별도 정렬하지 않는다.
function groups(){
  const rows=ordered(), map=new Map();
  rows.forEach(t=>{
    const key = epicKeyOf(t);
    // 묶인 레인에는 Jira 키가 하나로 정해지지 않으므로 key 를 비운다 —
    // 레인 오른쪽의 이슈 링크 칩이 자연히 사라진다(어느 에픽으로 보낼지 고를 수 없다).
    const eg = epicGroupFor(t);
    if(!map.has(key)) map.set(key,{gkey:key,
      key: eg ? null : ((t.epic&&t.epic.key)||null),
      name: eg ? eg.name : ((t.epic&&t.epic.name)||"미분류"), tasks:[]});
    map.get(key).tasks.push(t);
  });
  const arr=[...map.values()];
  arr.forEach((g,i)=>g.color=EPIC_COLORS[i%EPIC_COLORS.length]);
  return arr;
}

// 에픽의 기간 = 하위 작업의 min(시작) ~ max(종료). 날짜 문자열이 ISO(YYYY-MM-DD)라
// 사전순 비교가 곧 시간순 비교다 — Date 로 바꿀 필요가 없다.
function epicSpan(tasks){
  let s=null, e=null;
  tasks.forEach(function(t){
    if(!t || !t.start || !t.end) return;
    if(s===null || t.start < s) s = t.start;
    if(e===null || t.end   > e) e = t.end;
  });
  return (s===null || e===null) ? null : { start:s, end:e };
}

// 통계 카드를 눌러 들어가는 '선행 대기 · 기한 초과' 목록과 **같은 기준**을 쓴다.
// isBlocked(선행이 하나라도 미완료)로 세면 32건이 잡히는데 그중 지금 실제로 기다리는 건
// 6건뿐이라, 그 숫자로는 어느 에픽을 봐야 할지 알 수 없었다. (숫자는 2026-08-19 기준)
function epicSummary(g){
  const n=g.tasks.length;
  const d=g.tasks.filter(t=>t.status==="done").length;
  const w=g.tasks.filter(isWaiting).length;
  const r=g.tasks.filter(t=>t.status==="risk").length;
  return "작업 "+n+" · 완료 "+d+(w?" · 선행 대기 "+w:"")+(r?" · 기한 초과 "+r:"");
}

// 레인(에픽)이 통째로 끝났나. **작업이 하나도 없으면 완료가 아니다** — every 는 빈 배열에
// 참을 주므로 그대로 두면 빈 레인이 완료로 표시된다.
// 판정은 t.status 로 한다. 화면에 적는 이름은 stLabel 이지만 여기는 접힌 값으로 재는 자리다.
function epicAllDone(g){
  return g.tasks.length > 0 && g.tasks.every(function(t){ return t.status==="done"; });
}

/* ---------- 화면 상태 (데이터가 아니라 보는 사람의 편의) ---------- */
// file:// 에서는 localStorage 가 막힐 수 있다(Safari 는 차단, Chrome 도 설정에 따라 던짐).
// 실패해도 앱이 죽지 않게 전부 삼키고 메모리 상태로만 동작시킨다.
const UI_KEY = "goalchart.ui";
// 기본 460px. 에픽 줄에 이름·현황·키가 함께 들어가는데 320 에서는 24개 중 23개가
// 잘렸다(460 이면 4개). 2주 창(19일 × 46px ≒ 874px)은 그러고도 남는다.
const LABEL_W_MIN = 160, LABEL_W_MAX = 560, LABEL_W_DEFAULT = 460;
function clampLabelW(w){ return Math.max(LABEL_W_MIN, Math.min(LABEL_W_MAX, Math.round(w)||LABEL_W_DEFAULT)); }
function loadUI(){
  try{
    const raw = localStorage.getItem(UI_KEY);
    const o = raw ? JSON.parse(raw) : {};
    return { labelW: clampLabelW(o.labelW || LABEL_W_DEFAULT),
             expanded: Array.isArray(o.expanded) ? o.expanded.slice() : [],
             // 기본은 "full". 이름이 잘려 보이면 차트를 읽을 수 없어서다 —
             // 명시적으로 "clip" 을 저장한 사람만 잘라 보여준다.
             barText: o.barText === "clip" ? "clip" : "full" };
  }catch(e){ return { labelW: LABEL_W_DEFAULT, expanded: [], barText: "full" }; }
}
let ui = loadUI();
function saveUI(){ try{ localStorage.setItem(UI_KEY, JSON.stringify(ui)); }catch(e){} }

// 막대 글자: "clip" = 막대 안에서 말줄임, "full" = 막대 밖 오른쪽에 전체 표시
function barTextIsFull(){ return ui.barText === "full"; }
function toggleBarText(){ ui.barText = barTextIsFull() ? "clip" : "full"; saveUI(); render(); }

// 기본은 접힘. "접힌 목록"이 아니라 "펼친 목록"을 저장하는 이유는, 나중에 데이터에
// 에픽이 추가돼도 목록에 없으니 자동으로 접힌 채로 나오기 때문이다.
// 드래그를 마치면 브라우저가 click 을 안 보내는 게 보통이지만 항상 그렇지는 않다.
// 한 번이라도 새면 끌어놓을 때마다 편집 모달이 열려 성가시다. **마커 밖에 둔다** —
// 행의 onclick 문자열은 뷰어·편집본이 함께 쓰는데, 여기가 편집 전용이면 뷰어가
// ReferenceError 로 죽고 인라인 핸들러라 예외도 안 보인다(TOP_*_EDIT 로 겪은 유형).
let dragEndedAt = 0;
function afterDrag(){ return Date.now() - dragEndedAt < 250; }

function isCollapsed(gkey){ return ui.expanded.indexOf(gkey) === -1; }
function toggleEpicAt(i){
  if(afterDrag()) return;
  const g = groups()[i]; if(!g) return;
  const at = ui.expanded.indexOf(g.gkey);
  if(at === -1) ui.expanded.push(g.gkey); else ui.expanded.splice(at,1);
  saveUI(); render();
}
// 에픽이 하나도 없으면 "전부 펼쳐짐"으로 보지 않는다 — 빈 차트에서 버튼이
// "전체 접기"로 뜨면 누를 게 없는데 접겠다고 말하는 꼴이 된다.
function allEpicsExpanded(){
  const gs = groups();
  return gs.length > 0 && gs.every(function(g){ return !isCollapsed(g.gkey); });
}
function toggleAllEpics(){
  ui.expanded = allEpicsExpanded() ? [] : groups().map(function(g){ return g.gkey; });
  saveUI(); render();
}

function applyLabelWidth(){ document.getElementById("labels").style.width = ui.labelW + "px"; }
function initResizer(){
  const rz = document.getElementById("resizer"), lb = document.getElementById("labels");
  let startX = 0, startW = 0, dragging = false;
  rz.addEventListener("pointerdown", e=>{
    dragging = true; startX = e.clientX; startW = lb.offsetWidth;
    rz.classList.add("drag"); rz.setPointerCapture(e.pointerId); e.preventDefault();
  });
  rz.addEventListener("pointermove", e=>{
    if(!dragging) return;
    ui.labelW = clampLabelW(startW + (e.clientX - startX));
    applyLabelWidth();
  });
  const end = ()=>{ if(!dragging) return; dragging = false; rz.classList.remove("drag"); saveUI(); };
  rz.addEventListener("pointerup", end);
  rz.addEventListener("pointercancel", end);
}

// 에픽 헤더 행 + (펼쳐진 에픽의) 작업 행을 세로로 쌓는다. 좌측 라벨과 타임라인이
// **같은 lay 를 쓰는 것**이 이 구조의 핵심이다 — 두 곳이 따로 계산하면 어긋난다.
// 접힌 에픽의 작업은 taskY 에 들어가지 않는다 → 막대·화살표 루프의 기존 가드가
// 알아서 걸러낸다(양 끝점이 있어야 그린다). 접기 전용 분기를 새로 만들지 말 것.
function layoutRows(gs){
  let y=0; const lay=[]; const taskY={};
  gs.forEach((g,gi)=>{
    const col=isCollapsed(g.gkey);
    lay.push({type:"epic", g:g, gi:gi, y:y, collapsed:col}); y+=EPIC_H;
    if(!col) g.tasks.forEach(t=>{ lay.push({type:"task", t:t, y:y}); taskY[t.id]=y; y+=ROW_H; });
  });
  return {lay:lay, taskY:taskY, H:y};
}

// 담당자 칸에는 '홍길동 · 시작일 미정'처럼 사유가 섞여 들어온다(날짜가 빈 이슈를 오늘에
// 붙이면서 붙인 꼬리표다). 이름과 사유를 갈라 놓아야 칩으로 따로 보여줄 수 있다.
function ownerParts(owner){
  const p=String(owner||"").split(" · ");
  return {name:p[0]||"", miss:p.slice(1).join(" · ")};
}

// 작업 줄에 붙는 주의 칩. 지금 무엇이 문제인지만 담는다 — 기한 초과와 선행 대기는 함께 뜨지
// 않는다(기한 초과가 더 급한 신호라 그쪽만 남긴다).
// f(표시 창)는 없어도 된다 — 표·상세 패널처럼 창 개념이 없는 자리에서는 '기간 밖'만 빠진다.
function flagsOf(t, f){
  const out=[];
  if(t.status==="risk") out.push({k:"risk", s:"기한 초과"});
  else if(isWaiting(t)) out.push({k:"wait", s:"선행 대기"});
  const miss=ownerParts(t.owner).miss;
  if(miss) out.push({k:"miss", s:miss});
  if(f && outOfWindow(f,t)) out.push({k:"oow", s:"기간 밖"});
  return out;
}
function flagsHtml(t, f){
  return flagsOf(t,f).map(function(x){ return '<span class="flag '+x.k+'">'+esc(x.s)+'</span>'; }).join("");
}

function labelsHtml(lay, gs, f){
  let lh='<div class="lhead">작업 '+state.tasks.length+'개 · 에픽 '+gs.length+'개</div>';
  lay.forEach(it=>{
    if(it.type==="epic"){
      const g=it.g;
      const chip = g.key ? '<a class="ekey" href="'+jiraUrl(g.key)+'" target="_blank" rel="noopener" onclick="event.stopPropagation()">'+esc(g.key)+' ↗</a>' : '';
      // 접든 펼치든 항상 보인다. 펼친 상태에서 '선행 대기·기한 초과'가 사라지면
      // 정작 안을 들여다볼 때 그 에픽의 현황을 알 수 없다.
      const sum = '<span class="esum">'+esc(epicSummary(g))+'</span>';
      // 끝난 레인은 가라앉히고(.done 이 이름·요약의 채도를 낮춘다) 배지 하나만 또렷하게
      // 남긴다 — 남은 일을 찾는 화면이라 완료가 눈을 가져가면 안 된다.
      const fin = epicAllDone(g);
      const done = fin ? '<span class="edone">✅ 완료</span>' : '';
      let mv = "", dnd = "";
      
      // 좌측 폭이 좁으면 이름이 잘린다(요약·키가 자리를 먼저 가져간다). 잘린 채로 두면
      // 어느 에픽인지 알 수 없으므로 전체 이름과 현황을 툴팁에 담는다.
      const etip=esc(g.name+' — '+epicSummary(g)+(fin?' · 레인 완료':'')+(g.key?' ('+g.key+')':''))+'&#10;클릭해서 접기/펼치기';
      lh += '<div class="erow'+(fin?' done':'')+'"'+dnd+' style="border-left:3px solid '+g.color+'" onclick="toggleEpicAt('+it.gi+')" title="'+etip+'">'+
        '<span class="ecar">'+(it.collapsed?'+':'−')+'</span>'+
        '<span class="edot" style="background:'+g.color+'"></span><span class="enm">'+esc(g.name)+'</span>'+done+sum+chip+mv+'</div>';
    }else{
      const t=it.t, blk=isBlocked(t);
      const jk = t.jira ? '<a class="jkey" href="'+jiraUrl(t.jira)+'" target="_blank" rel="noopener" onclick="event.stopPropagation()">'+esc(t.jira)+'</a> · ' : '';
      let mv = "", dnd = "";
      
      lh += '<div class="lrow"'+dnd+' onclick="openEdit('+t.id+')">'+
        '<div class="nm"><span class="sdot" style="background:'+STVAR[t.status]+'"></span>'+esc(t.name)+(blk?' <span class="lock" title="선행 작업이 완료되지 않아 대기 중">⏳</span>':'')+'</div>'+
        '<div class="meta">'+jk+esc(ownerParts(t.owner).name)+' · '+mmdd(t.start)+'~'+mmdd(t.end)+flagsHtml(t,f)+'</div>'+mv+'</div>';
    }
  });
  return lh;
}

// 주 구분과 날짜 칸.
function timelineHeadHtml(f, W){
  let head='<div class="thead" style="width:'+W+'px">';
  const nWeeks=Math.ceil(f.days/7);
  for(let w=0;w<nWeeks;w++){
    const ws=addD(f.start,w*7);
    const wend=addD(ws,6);
    head+='<div class="wk" style="left:'+(w*7*DAY_W)+'px; width:'+(7*DAY_W)+'px">Week '+(w+1)+
          ' &nbsp;<span style="color:var(--muted);font-weight:500">'+mmdd(iso(ws))+'~'+mmdd(iso(wend))+'</span></div>';
  }
  for(let i=0;i<f.days;i++){
    const d=addD(f.start,i), wknd=(d.getDay()===0||d.getDay()===6);
    head+='<div class="dcell'+(wknd?' wknd':'')+'" style="left:'+(i*DAY_W)+'px; width:'+DAY_W+'px">'+
          '<span>'+WD[d.getDay()]+'</span><span class="dn">'+d.getDate()+'</span></div>';
  }
  head+='</div>';
  return head;
}

// 배경 격자 · 에픽 스윔레인 밴드와 롤업 막대 · 오늘 선 · 마감 깃발.
function gridBackgroundHtml(f, lay, W, H){
  let grid='<div class="grid" style="width:'+W+'px; height:'+H+'px">';
  for(let i=0;i<f.days;i++){
    const d=addD(f.start,i), wknd=(d.getDay()===0||d.getDay()===6);
    grid+='<div class="col'+(wknd?' wknd':'')+'" style="left:'+(i*DAY_W)+'px; width:'+DAY_W+'px"></div>';
  }
  // epic swimlane bands
  lay.forEach(it=>{ if(it.type==="epic"){
    grid+='<div class="eband" style="top:'+it.y+'px; height:'+EPIC_H+'px; width:'+W+'px; background:'+hexA(it.g.color,0.12)+'; border-left:3px solid '+it.g.color+'"></div>';
    // 롤업 막대: 하위 작업 전체 기간. 접힘 여부와 무관하게 항상 그린다.
    const sp=epicSpan(it.g.tasks);
    if(sp){
      const sIdx=diffD(f.start,pd(sp.start)), eIdx=diffD(f.start,pd(sp.end));
      if(!(eIdx<0 || sIdx>f.days-1)){
        const cs=Math.max(sIdx,0), ce=Math.min(eIdx,f.days-1);
        const clipL=sIdx<0, clipR=eIdx>f.days-1;
        const left=cs*DAY_W+4, width=Math.max((ce-cs+1)*DAY_W-8,10);
        grid+='<div class="ebar'+(clipL?' clipL':'')+(clipR?' clipR':'')+'" style="left:'+left+'px; top:'+
              (it.y+(EPIC_H-11)/2)+'px; width:'+width+'px; background:'+it.g.color+'" title="'+
              esc(it.g.name)+' · '+mmdd(sp.start)+'~'+mmdd(sp.end)+' · '+esc(epicSummary(it.g))+'"></div>';
      }
    }
  }});
  // today
  const ti=diffD(f.start,todayMid());
  if(ti>=0 && ti<f.days){
    const x=ti*DAY_W;
    grid+='<div class="todayline" style="left:'+x+'px"></div>'+
          '<div class="todaytag" style="left:'+x+'px">오늘</div>';
  }
  // deadline flag
  const di=diffD(f.start,pd(state.deadline));
  if(di>=0 && di<f.days){
    grid+='<div class="dlflag" style="left:'+(di*DAY_W+DAY_W/2)+'px" title="마감일">🎯</div>';
  }
  return grid;
}

/* ---------- 의존 화살표의 꺾인선(직교) 경로 ---------- */
// 종전에는 베지어 곡선이었다. 곡선은 어느 행에서 어느 행으로 가는지가 눈으로 안 잡히고,
// 여러 개가 겹치면 어느 선이 어디로 가는지 구별되지 않는다. 간트차트의 관례대로
// 가로-세로만 쓰는 꺾인선으로 그린다.
const DEP_STUB = 14;   // 막대에서 처음 곧게 빠져나오는 길이. 화살표가 막대에 붙지 않게 한다.
const DEP_R    = 6;    // 모서리 둥글기. 0 이면 직각.

// 선행 막대 오른쪽 끝(x1,y1) → 후행 막대 왼쪽 끝(x2,y2) 을 잇는 꺾임점들.
// 되돌아가는 링크(후행이 선행보다 왼쪽에서 시작)는 4점으로 못 그린다 — 가로로 되돌아가는
// 구간이 필요하고, 그 구간은 **행 사이 빈 틈**을 타야 막대를 가로지르지 않는다
// (ROW_H 46 > BAR_H 26 이라 위아래로 10px 씩 남는다).
function elbowPoints(x1, y1, x2, y2, minX, maxX, rowH){
  const cl=(x)=>Math.max(minX,Math.min(maxX,x));
  const a=cl(x1+DEP_STUB);
  // 앞으로 가는 링크: 빠져나와서 → 세로로 → 후행으로. 세로 구간은 선행 바로 뒤에 둔다.
  if(x2 >= a+DEP_STUB) return [[x1,y1],[a,y1],[a,y2],[x2,y2]];
  const b=x2-DEP_STUB;
  const ym=y1+(y2>y1 ? rowH/2 : -rowH/2);   // 선행 행의 경계 = 막대가 없는 자리
  // **왼쪽으로 물러설 자리가 없는 경우**(후행이 창 밖이라 시작점이 가장자리에 눌렸다).
  // 가로로 들어가려면 창을 넘어야 하는데 svg 가 overflow:visible 이라 라벨 칸을 침범한다.
  // 그래서 여기서만 세로로 들어간다 — 화살표가 아래를 향하는 대신 선이 제자리에 남는다.
  if(b < minX){
    if(x1===x2) return [[x1,y1],[x2,y2]];   // 둘 다 같은 가장자리 — 좌우로 왕복할 이유가 없다
    return [[x1,y1],[a,y1],[a,ym],[x2,ym],[x2,y2]];
  }
  return [[x1,y1],[a,y1],[a,ym],[cl(b),ym],[cl(b),y2],[x2,y2]];
}

// 꺾임점들을 SVG path 로. 모서리는 반지름 r 만큼 깎아 2차 베지어로 잇는다.
// **겹치는 점은 먼저 걸러낸다** — 창 가장자리에서 클램프되면 같은 점이 연달아 나오는데,
// 그대로 두면 0 으로 나누게 되고 path 에 NaN 이 박혀 선이 통째로 사라진다.
function roundedPath(pts, r){
  const p=[];
  for(const q of pts){ const l=p[p.length-1]; if(!l || l[0]!==q[0] || l[1]!==q[1]) p.push(q); }
  if(p.length<2) return "";
  const n=(v)=>Math.round(v*10)/10;
  let d="M"+n(p[0][0])+" "+n(p[0][1]);
  for(let i=1;i<p.length-1;i++){
    const [px,py]=p[i-1], [cx,cy]=p[i], [nx,ny]=p[i+1];
    const d1=Math.hypot(cx-px,cy-py), d2=Math.hypot(nx-cx,ny-cy);
    const rr=Math.min(r, d1/2, d2/2);
    if(!(rr>0.5)){ d+=" L"+n(cx)+" "+n(cy); continue; }   // 너무 짧은 구간은 그냥 직각으로
    d+=" L"+n(cx-(cx-px)/d1*rr)+" "+n(cy-(cy-py)/d1*rr)+
       " Q"+n(cx)+" "+n(cy)+" "+n(cx+(nx-cx)/d2*rr)+" "+n(cy+(ny-cy)/d2*rr);
  }
  const e=p[p.length-1];
  return d+" L"+n(e[0])+" "+n(e[1]);
}

// 의존 화살표. 선행이 안 끝났으면 빨간 점선. 양 끝점이 taskY 에 있어야 그린다
// (접힌 에픽의 작업은 taskY 에 없으므로 자동으로 빠진다).
function arrowsHtml(f, taskY, W, H){
  let grid='<svg class="arrows" width="'+W+'" height="'+H+'">'+
        '<defs>'+
        '<marker id="ah" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0 0 L6 3 L0 6 z" fill="var(--dep)"/></marker>'+
        '<marker id="ahb" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0 0 L6 3 L0 6 z" fill="var(--dep-block)"/></marker>'+
        '</defs>';
  state.tasks.forEach(t=>{
    if(!(t.id in taskY)) return;
    (t.deps||[]).forEach(pid=>{
      const p=state.tasks.find(x=>x.id===pid); if(!p||!(pid in taskY)) return;
      const pEnd=diffD(f.start,pd(p.end));
      const sStart=diffD(f.start,pd(t.start));
      const Wa=f.days*DAY_W, cl=(x)=>Math.max(4,Math.min(Wa-4,x));
      const x1=cl((pEnd+1)*DAY_W-4), y1=taskY[pid]+ROW_H/2;
      const x2=cl(sStart*DAY_W+4),   y2=taskY[t.id]+ROW_H/2;
      const block=(p.status!=="done");
      const c=block?"var(--dep-block)":"var(--dep)";
      const dash=block?'stroke-dasharray="5 3"':'';
      const d=roundedPath(elbowPoints(x1,y1,x2,y2,4,Wa-4,ROW_H), DEP_R);
      if(!d) return;
      grid+='<path d="'+d+'" fill="none" stroke="'+c+'" stroke-width="2" '+dash+
            ' stroke-linecap="round" marker-end="url(#'+(block?'ahb':'ah')+')"/>';
    });
  });
  grid+='</svg>';
  return grid;
}

// 작업 막대. 표시 창 밖은 가장자리 압축 칩(‹ ›)으로 대신한다.
function barsHtml(f, taskY){
  let grid='';
  const Wpx=f.days*DAY_W;
  state.tasks.forEach(t=>{
    if(!(t.id in taskY)) return;
    const sIdx=diffD(f.start,pd(t.start)), eIdx=diffD(f.start,pd(t.end));
    const top=taskY[t.id]+(ROW_H-BAR_H)/2, cy=taskY[t.id]+ROW_H/2;
    const blk=isBlocked(t);
    const oo = eIdx<0 ? "before" : (sIdx>f.days-1 ? "after" : null);
    if(oo){
      const x = oo==="before" ? 2 : (Wpx-16);
      grid+='<div class="edgechip '+t.status+'" style="left:'+x+'px; top:'+top+'px" onclick="openEdit('+t.id+')" '+
            'title="'+esc(t.name)+' — 기간 밖('+(oo==="before"?"이전":"이후")+') '+mmdd(t.start)+'~'+mmdd(t.end)+'">'+(oo==="before"?"‹":"›")+'</div>';
      return;
    }
    const cs=Math.max(sIdx,0), ce=Math.min(eIdx,f.days-1);
    const clipL=sIdx<0, clipR=eIdx>f.days-1;
    if(t.milestone && !clipL && !clipR){
      const x=(eIdx+1)*DAY_W-DAY_W/2-10;
      grid+='<div class="milestone'+(blk?' blocked':'')+'" style="left:'+x+'px; top:'+(cy-10)+'px" title="'+esc(t.name)+'" onclick="openEdit('+t.id+')"></div>';
      return;
    }
    const left=cs*DAY_W+4, width=Math.max((ce-cs+1)*DAY_W-8,22);
    const tip='title="'+esc(t.name)+' ('+stLabel(t)+') '+mmdd(t.start)+'~'+mmdd(t.end)+'"';
    const cls='bar '+t.status+(blk?' blocked':'')+(clipL?' clipL':'')+(clipR?' clipR':'');
    const inner=(clipL?'<span class="clip">‹</span>':'')+'<span class="ic">'+STICON[t.status]+'</span>';
    const tail=(clipR?'<span class="clip">›</span>':'');
    // 마크업은 두 모드가 같다. 넘칠지 자를지는 .tl-full 이 CSS 로 정한다 —
    // 그래야 글자 시작 위치가 모드와 무관하게 막대 안 제자리로 고정된다.
    grid+='<div class="'+cls+'" style="left:'+left+'px; top:'+top+'px; width:'+width+'px" onclick="openEdit('+t.id+')" '+tip+'>'+
          inner+'<span class="bnm">'+esc(t.name)+'</span>'+tail+'</div>';
  });
  return grid;
}

// 첫 그리기에서 한 번만 오늘 칸이 가운데 오도록 가로 스크롤한다. 표시 창이 2주라
// 왼쪽 끝에서 시작하면 지난 날짜부터 보게 된다. 그릴 때마다 하면 보는 사람이 옮겨 둔
// 위치를 되돌려 버리므로 한 번으로 막는다. 오늘이 표시 창 밖이면 건드리지 않는다.
// **첫 render() 시점에는 차트가 아직 숨어 있다** — setLoading(false) 가 chartBody 를
// 되살리지 않고 뒤따르는 syncPanes() 가 한다. 폭이 0 인 요소에 scrollLeft 를 쓰면
// 브라우저가 0 으로 잘라 버려 아무 일도 안 일어난다(이 순서 때문에 처음 배포한 판이
// 동작하지 않았다). 그래서 한 프레임 뒤에 재고, 그래도 폭이 0 이면 플래그를 쓰지 않아
// 다음 그리기에서 다시 시도한다.
let focusedToday=false;
function focusToday(f){
  if(focusedToday) return;
  const run=function(){
    if(focusedToday) return;
    const sc=document.querySelector(".tl-scroll");
    if(!sc || !sc.clientWidth) return;
    focusedToday=true;
    const ti=diffD(f.start, todayMid());
    if(ti<0 || ti>=f.days) return;
    sc.scrollLeft=Math.max(0, ti*DAY_W - Math.max(0,(sc.clientWidth-DAY_W)/2));
  };
  if(typeof requestAnimationFrame==="function") requestAnimationFrame(run); else run();
}

// 조립만 한다. 각 조각이 문자열을 만들고 여기서 두 번의 innerHTML 로 끝난다 —
// 조각을 늘리더라도 DOM 쓰기는 이 두 곳으로 유지할 것(중간 리플로우를 만들지 않는다).
function render(){
  const f=frame();
  syncTop();

  const gs=groups();
  const {lay, taskY, H}=layoutRows(gs);

  document.getElementById("labels").innerHTML = labelsHtml(lay, gs, f);

  const tl=document.getElementById("timeline");
  const W=f.days*DAY_W;
  tl.style.width=W+"px";
  tl.className = "timeline" + (barTextIsFull() ? " tl-full" : "");
  tl.innerHTML = timelineHeadHtml(f, W)
               + gridBackgroundHtml(f, lay, W, H)
               + arrowsHtml(f, taskY, W, H)
               + barsHtml(f, taskY)
               + '</div>';

  focusToday(f);

  renderStats(f);
  renderTable();
  // **드릴다운 목록이 열려 있으면 같이 다시 그린다.** 표(renderTable)는 이미 그러고 있는데
  // 이 목록만 빠져 있었다 — 그래서 목록에서 작업을 열어 지워도 지운 행이 그대로 남았다
  // (차트는 갱신되는데 보고 있는 화면만 낡은 채였다). render() 를 '전부 다시 그린다'로
  // 유지하면 삭제·저장·순서변경·갱신이 전부 한 번에 맞는다.
  // drillKind 는 아래에 let 으로 선언돼 있지만, render() 를 부르는 곳이 전부 함수 안이고
  // 부트는 파일 맨 끝이라 실행 시점에는 이미 초기화돼 있다.
  if(drillKind) renderDrill();
}

function renderStats(f){
  const T=state.tasks, n=T.length;
  const done=T.filter(t=>t.status==="done").length;
  // 완료 건수만으로 센다. 손으로 적는 진척률은 관리 비용만 들고 믿을 수 없어 걷어냈다.
  const prog=Math.round(done*100/Math.max(n,1));
  const dday=diffD(todayMid(),pd(state.deadline));
  // 카드 숫자는 목록과 같은 기준이어야 한다 — 눌러서 들어갔을 때 건수가 달라지면 안 된다.
  const blocked=T.filter(isWaiting).length;
  const risk=T.filter(t=>t.status==="risk").length;
  const hold=T.filter(isHold).length;
  const ddText = dday>0?("D-"+dday):(dday===0?"D-Day":("D+"+(-dday)));
  document.getElementById("stats").innerHTML =
    stat("마감까지", ddText, "마감 "+mmdd(state.deadline)) +
    stat("전체 진척률", prog+"%", done+" / "+n+" 완료", prog, "done") +
    // '대기 중'은 진행중에서 빼서 따로 센다 — statusCategory 로는 둘이 같은 칸에 접혀서,
    // 착수도 안 한 일이 진행 중으로 세어졌다(2026-08-20 기준 93건 중 17건이 그랬다).
    stat("진행중", (T.filter(t=>t.status==="inprog").length - hold)+"건",
         "검수 요청 "+T.filter(t=>t.status==="review").length+" · 예정 "+T.filter(t=>t.status==="todo").length+" · 대기 중 "+hold, undefined, "active") +
    stat("선행 대기·기한 초과", (blocked+risk)+"건", "⏳ 선행 대기 "+blocked+" · ⚠ 기한 초과 "+risk, undefined, "attention");
}
// kind 를 주면 눌러서 목록으로 들어가는 카드가 된다. onclick 은 인자 조립 없이
// 리터럴 하나만 넣는다 — 문자열을 이어 붙이다 문법이 깨지면 핸들러가 통째로 죽는다.
function stat(k,v,s,pct,kind){
  const mini = (pct!==undefined) ? '<div class="bar-mini"><i style="width:'+pct+'%"></i></div>' : '';
  if(!kind) return '<div class="stat"><div class="k">'+k+'</div><div class="v">'+v+'</div><div class="s">'+s+'</div>'+mini+'</div>';
  return '<div class="stat tap" role="button" tabindex="0" onclick="openDrill(\''+kind+'\')"'+
         ' onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();openDrill(\''+kind+'\');}">'+
         '<div class="k">'+k+'</div><div class="v">'+v+'</div><div class="s">'+s+'</div>'+mini+
         '<div class="more">목록 보기 →</div></div>';
}

/* ---------- 데이터가 얼마나 낡았나 (편집본 전용) ---------- */

/* ---------- Jira 최신값 적용 (양쪽 공통) ---------- */
// 뷰어는 열 때 자동으로, 편집본은 버튼으로 부른다. **마커 밖에 둬야 한다** —
// 한쪽 마커 안에 넣으면 다른 쪽에서 ReferenceError 가 나고, 인라인 핸들러라 예외도 안 보인다.
// Jira 가 갖지 않는 것(의존관계·표시 순서·표시 창·마감)은 건드리지 않는다.
// Jira 의 '대기 중'은 statusCategory 가 indeterminate 라 '진행 중'과 구별되지 않는다.
// 날짜가 비었다고 오늘에 붙이면 지금 하는 일처럼 보이는데, 실제로는 착수 시점이 안 정해진
// 일이다. 그래서 이런 것들은 차트의 마지막 날에 모아 둔다.
const HOLD_STATUS = { "대기 중": true };

// 모아 둘 자리 = **화면에 보이는 마지막 날**. 표시 창이 켜져 있으면 그 끝을 쓴다 —
// 마감일을 쓰면 창 밖으로 밀려 압축 칩에 숨어 버리는 경우가 생긴다.
function holdDateOf(chart){
  const w = chart && chart.window;
  if(w && w.on && w.end) return w.end;
  return (chart && chart.deadline) || "";
}

function applyJiraIssues(tasks, issues, today, holdAt){
  const by={}; issues.forEach(function(x){ by[x.key]=x; });
  // 의존관계를 Jira 기준으로 맞추려면 '이슈 키 → 차트 id' 표가 필요하다.
  const idByKey={}; tasks.forEach(function(x){ if(x.jira) idByKey[x.jira]=x.id; });
  let n=0;
  tasks.forEach(function(t){
    const j=by[t.jira]; if(!j) return;
    n++;
    if(j.name) t.name=j.name;
    let start=j.start, end=j.end, miss="";
    // 날짜가 비면 오늘에 붙이고 사유를 담당자 칸에 덧붙인다 (data 생성 규칙과 같다).
    // 날짜가 아예 없을 때만 자리를 정해 준다. '대기 중'은 맨 끝, 나머지는 오늘.
    if(!start && !end){ start=end=(holdAt && HOLD_STATUS[j.statusName]) ? holdAt : today; miss="일정 미정"; }
    else if(!start){ start=end; miss="시작일 미정"; }
    else if(!end){ end=start; miss="마감 미정"; }
    if(end<start){ const x=start; start=end; end=x; }
    t.start=start; t.end=end;
    t.owner=[(j.owner||""), miss].filter(Boolean).join(" · ");
    // 기한 초과 판정은 '지금' 기준으로 다시 한다 — 저장된 값은 빌드 시점에 굳은 것이다.
    // done 과 review 는 덮지 않는다. 검수 요청은 작업이 끝나고 확인만 남은 상태라,
    // 마감이 지났다고 '기한 초과'로 바꾸면 정작 누가 확인해야 하는지가 보이지 않는다.
    // **마감이 없으면 기한 초과가 될 수 없다.** end 는 마감이 빌 때 시작일이나 오늘로
    // 메운 값이라, 그걸로 판정하면 지날 마감이 없는 작업이 늦은 것으로 찍힌다
    // (ORVV-9418 이 실제로 그랬다). 판정은 Jira 의 진짜 마감(j.end)이 있을 때만 한다.
    t.status=(!DONE_LIKE[j.status] && j.end && t.end<today) ? "risk" : j.status;
    // **접기 전 이름을 남긴다.** 이게 없으면 화면은 접힌 값밖에 못 봐서 '대기 중'을
    // '진행중'으로 적는다. 필드가 없는 응답(옛 Worker)은 저장된 값을 그대로 둔다
    // — doneAt·blockedBy 와 같은 규칙이다.
    if("statusName" in j) t.statusName = j.statusName || "";
    if(j.epicKey)  t.epic.key=j.epicKey;
    if(j.epicName) t.epic.name=j.epicName;
    // 실제로 완료 처리된 날(Jira resolutiondate). 마감(end)과 견줘야 일찍 끝났는지
    // 늦었는지가 나오므로 마감일로 대신할 수 없다. 필드가 아예 없는 응답(옛 Worker)은
    // 건드리지 않는다 — 그 경우 저장된 값이 진실이다(blockedBy 와 같은 규칙).
    if("doneAt" in j) t.doneAt = j.doneAt || null;
    // 의존관계도 Jira 를 따른다(Blocks 링크). 차트에 없는 이슈는 id 가 없어 참조할 수 없으므로
    // 건너뛴다. **뺄 때는 Jira 에서 빼야 한다** — 되쓰기는 링크를 추가만 하고 지우지 않아서,
    // 차트에서만 지우면 여기서 다시 들어온다.
    // blockedBy 가 아예 없는 응답(옛 Worker)은 건드리지 않는다 — 그 경우 저장된 값이 진실이다.
    if(Array.isArray(j.blockedBy)){
      t.deps=j.blockedBy.map(function(k){ return idByKey[k]; })
        .filter(function(id){ return id!==undefined; })
        .sort(function(a,b){ return a-b; });   // 순서를 고정해야 갱신마다 같은 결과가 나온다
    }
  });
  return n;
}

// 값이 확정되기 전에는 차트를 그리지 않고 로딩 자리만 보여준다. 양쪽이 함께 쓴다 —
// 뷰어는 열 때 자동 갱신에서, 편집본은 배포본으로 열렸을 때.
function setLoading(on){
  const ld=document.getElementById("loading");
  if(ld) ld.style.display = on ? "block" : "none";
  const body=document.getElementById("chartBody");
  if(body && on) body.style.display="none";   // 끌 때는 syncPanes 가 제 상태로 되돌린다
}

/* ---------- 열 때마다 자동 갱신 (뷰어 전용) ---------- */

// 페이지를 열 때마다 중계 Worker 에서 최신값을 받아 덮어쓴다.
// 실패하면 저장된 데이터 그대로 보여준다 — 차트가 안 뜨는 것보다 조금 낡은 게 낫다.
function showSyncNote(text, bad){
  const el=document.getElementById("syncNote");
  if(!el) return;
  el.textContent=text;
  el.className="sync-note"+(bad?" bad":"");
}

const SYNC_TIMEOUT = 8000;   // Worker 가 느려도 로딩 화면에 갇히지 않게 한다

// 뷰어의 첫 그리기는 여기서만 일어난다. 성공이든 실패든 **한 번만** 그리므로
// 인라인 값이 잠깐 보였다 바뀌는 일이 없다.
async function syncFromJira(){
  // 어느 차트인지는 data.json 이 싣고 온다. 셸은 모든 차트에서 같아야 하므로 여기에 박을 수
  // 없고, URL 경로에서 캐면 배포 위치가 바뀔 때 조용히 깨진다.
  //
  // 갱신을 못 하는 두 경우는 한 곳에서 빠져나간다 — 그리는 자리가 늘면 '값이 확정된 뒤
  // 한 번만 그린다'가 깨진다. 둘의 차이는 무엇을 적느냐다: syncEndpoint 가 비면 갱신을
  // 쓰지 않기로 한 정상 설정이라 알릴 것이 없고, chartId 가 없으면 설정이 깨진 것이라
  // 그대로 알린다. 여기서 조용히 물러나면 둘이 화면상 구별되지 않아, 갱신이 꺼진 줄
  // 모른 채 차트가 며칠 낡는다.
  const cantSync = !state.syncEndpoint ? ""
    : (!state.chartId ? "Jira 갱신 불가 — data.json 에 chartId 가 없습니다" : null);
  if(cantSync!==null){ setLoading(false); render(); syncPanes(); showSyncNote(cantSync, !!cantSync); return; }
  const url=String(state.syncEndpoint).replace(/\/+$/,"") + "/?chart=" + encodeURIComponent(state.chartId);
  setLoading(true);
  showSyncNote("Jira 최신값 확인 중…");
  // AbortSignal.timeout 이 없는 브라우저도 있어 컨트롤러를 직접 쓴다.
  const ac=(typeof AbortController!=="undefined") ? new AbortController() : null;
  const timer=ac ? setTimeout(function(){ ac.abort(); }, SYNC_TIMEOUT) : null;
  try{
    const res=await fetch(url, ac ? {cache:"no-store", signal:ac.signal} : {cache:"no-store"});
    const text=await res.text();
    if(!res.ok){
      // Worker 는 오류도 JSON({error:"..."})으로 주므로 그게 가장 좋은 메시지다 —
      // lib/worker-client.js 의 fetchIssues 와 같은 규칙. 여기서 "HTTP "+status 만
      // 남기면 Worker 가 보낸 "chart 파라미터가 필요합니다" 같은 실제 원인이
      // 화면에서 사라진다. 파싱에 실패하면(엣지 타임아웃의 HTML 등) 본문 일부를 쓴다.
      let why=text.slice(0,200);
      try{ const b=JSON.parse(text); if(b && b.error) why=b.error; }catch{ /* 본문 그대로 쓴다 */ }
      throw new Error("HTTP "+res.status+": "+why);
    }
    let body;
    try{ body=JSON.parse(text); }catch{ throw new Error("응답이 JSON 이 아닙니다: "+text.slice(0,200)); }
    if(!body || !Array.isArray(body.issues)) throw new Error("응답 형식이 다릅니다");
    const n=applyJiraIssues(state.tasks, body.issues, iso(todayMid()), holdDateOf(state));
    const t=new Date();
    showSyncNote("Jira 최신 · "+t.getHours()+":"+String(t.getMinutes()).padStart(2,"0")+" 기준 "+n+"건 반영");
  }catch(e){
    const why=(e && e.name==="AbortError") ? "응답이 너무 늦습니다" : (e.message||e);
    showSyncNote("Jira 갱신 실패 — 저장된 데이터를 표시합니다 ("+why+")", true);
  }finally{
    if(timer) clearTimeout(timer);
    // 실패해도 반드시 그린다. 안 그리면 로딩 화면에 갇힌다.
    setLoading(false);
    render();
    syncPanes();
  }
}

/* ---------- 상태 드릴다운 ---------- */
// 통계 카드 → 해당 상태의 작업 목록. 각 뷰는 그룹 두 개로 나뉘고,
// 그룹 안의 순서는 state.tasks 배열 순서 그대로다(차트와 같은 순서로 읽히도록).
// 드릴다운 표의 칸 폭 (에픽·Jira·작업·담당·기간·마지막 여섯 칸).
// 빈 문자열은 '나머지를 다 가져가라'는 뜻이고, 작업 이름이 그 자리를 받는다.
// 종류 안의 모든 묶음이 같은 값을 쓰므로 묶음끼리 줄이 맞는다.
const COLW = ["22%", "96px", "", "96px", "108px", "110px"];
// 선행 작업 목록은 한 칸에 여러 줄이 들어가 훨씬 넓어야 한다.
const COLW_WIDE = ["17%", "96px", "", "92px", "104px", "32%"];
function colgroupHtml(w){
  return "<colgroup>"+w.map(function(x){ return x ? '<col style="width:'+x+'">' : "<col>"; }).join("")+"</colgroup>";
}

// 완료 작업이 실제로 완료 처리된 날(Jira resolutiondate). doneAt 이 없으면 마감일로
// 물러난다 — 목록에서 통째로 사라지는 것보다 낫고, '마감 대비' 칸이 그 사실을 밝힌다.
function doneDate(t){ return t.doneAt || t.end; }

// 마감 대비 며칠. 이 목록의 존재 이유가 이 칸이다 — 완료일만으로는 일정을 지켰는지 알 수 없다.
// 셀 수 없는 두 경우는 숫자를 지어내지 않고 그렇다고 적는다.
function vsDueText(t){
  if(!t.doneAt) return "완료일 미기록";
  const miss=ownerParts(t.owner).miss;
  if(miss==="일정 미정" || miss==="마감 미정") return "마감 없음";
  const d=diffD(pd(t.doneAt), pd(t.end));      // 마감 − 완료
  if(d>0) return d+"일 빠름";
  if(d<0) return (-d)+"일 늦음";
  return "정시";
}

// 완료 작업을 완료일별로 묶는다. 최근 날짜가 맨 앞에 온다.
function doneByDate(all){
  const dates=[...new Set(all.filter(t=>t.status==="done").map(doneDate))].sort().reverse();
  return dates.map(function(d){
    return { label: mmdd(d)+" ("+WD[pd(d).getDay()]+")",
             col: "마감 대비", cell: function(t){ return esc(vsDueText(t)); },
             pick: function(t){ return t.status==="done" && doneDate(t)===d; } };
  });
}

const DRILL = {
  done: {
    title: "완료 작업 — 완료일 기준",
    // 묶음이 데이터에 따라 달라지므로 groups 대신 groupsOf 로 그때그때 만든다.
    groupsOf: doneByDate,
  },
  active: {
    title: "진행중 · 검수 요청 · 예정 · 대기 중",
    groups: [
      // 카드가 '대기 중'을 진행중에서 빼고 세므로 목록도 같이 빼야 한다 — 두 숫자가
      // 어긋나면 눌러 들어갔을 때 건수가 달라진다.
      {label:"진행중",   pick:t=>t.status==="inprog" && !isHold(t)},
      {label:"검수 요청", pick:t=>t.status==="review"},
      {label:"예정",     pick:t=>t.status==="todo"},
      {label:"대기 중",   pick:isHold},
    ],
  },
  attention: {
    title: "선행 대기 · 기한 초과",
    colw: COLW_WIDE,   // 선행 작업 목록이 한 칸에 여러 줄로 들어간다
    groups: [
      {label:"선행 대기", pick:t=>isWaiting(t),     col:"선행 작업", cell:prevListHtml},
      {label:"기한 초과", pick:t=>t.status==="risk", col:"사유",      cell:t=>esc(riskReason(t))},
    ],
  },
};
let drillKind=null;

// 착수 준비 기간. 시작일이 아직 이만큼 남았으면 선행이 안 끝난 게 정상이라 목록에 넣지 않는다.
const LEAD_DAYS = 1;

// 선행 대기: 아직 '예정'이고, 선행이 미완료이고, 착수 준비 시점(시작일 -1일)을 이미 지난 것만.
//
// **'예정'만 세는 이유**(2026-08-19): 진행중이거나 검수 요청이면 이미 착수했다는 뜻이고,
// 그건 그 의존관계가 실제로는 막지 않았다는 증거다 — 선행 에셋을 받을 만큼만 받고 시작하는
// 일정 겹침이 흔하다. 이걸 세면 목록의 절반이 안 막힌 작업으로 채워져 쓸모가 없어진다.
// 기한 초과도 뺀다: 옆 칸에서 따로 세므로 여기서 또 세면 통계 카드가 같은 작업을 두 번
// 센다(칩도 이미 risk 를 우선한다). 결과적으로 두 목록은 서로 겹치지 않는다.
//
// 차트의 ⏳ 와 점선 화살표는 isBlocked 를 그대로 쓴다 — 그쪽은 의존관계라는 사실 자체를
// 그리는 것이고, 이 목록은 '지금 주목할 것'만 걸러내는 자리다. 그래서 진행중인데 선행이
// 덜 끝난 작업도 차트에서는 여전히 보인다. 목록에서만 소리를 내지 않을 뿐이다.
function isWaiting(t){
  if(t.status!=="todo") return false;
  if(!isBlocked(t)) return false;
  return diffD(addD(pd(t.start), -LEAD_DAYS), todayMid()) >= 0;
}

// 미완료 선행을 한 줄씩. 키·요약·그 선행 자신의 상태를 나란히 둔다.
function prevListHtml(t){
  const pend=(t.deps||[])
    .map(id=>state.tasks.find(x=>x.id===id))
    .filter(p=>p && p.status!=="done");
  if(!pend.length) return '<span style="color:var(--muted)">—</span>';
  return pend.map(function(p){
    const key=p.jira
      ? '<a class="pk" href="'+jiraUrl(p.jira)+'" target="_blank" rel="noopener" onclick="event.stopPropagation()">'+esc(p.jira)+'</a>'
      : '<span class="pk">키 없음</span>';
    return '<div class="pv">'+key+'<span class="pn">'+esc(p.name)+'</span>'+
           '<span class="pb '+p.status+'">'+stLabel(p)+'</span></div>';
  }).join("");
}
function riskReason(t){
  const over=diffD(pd(t.end), todayMid());
  return "마감 "+mmdd(t.end)+"이 지났으나 완료되지 않음"+(over>0?" ("+over+"일 경과)":"");
}

function openDrill(kind){
  if(!DRILL[kind]) return;
  const wasOpen = !!drillKind;
  drillKind=kind;
  // 차트 → 목록은 히스토리에 한 칸 쌓고, 목록 → 다른 목록은 그 칸을 갈아끼운다.
  // 목록 사이를 오간 흔적이 쌓이지 않으므로 뒤로가기도 '차트로 돌아가기'도 언제나 차트로 간다.
  try{
    if(wasOpen) history.replaceState({drill:kind}, "");
    else history.pushState({drill:kind}, "");
  }catch(e){}
  syncPanes(); renderDrill();
}
function closeDrill(){
  // 화면의 '차트로 돌아가기'도 뒤로가기와 같은 경로를 타게 한다 — 상태가 두 벌로 갈리지 않는다.
  // 쌓인 칸이 언제나 하나뿐이라 back() 한 번이면 차트다.
  if(history.state && history.state.drill){ history.back(); return; }
  drillKind=null; syncPanes();
}
window.addEventListener("popstate", function(ev){
  drillKind=(ev.state && ev.state.drill) || null;
  syncPanes();
  if(drillKind) renderDrill();
});

// 어느 화면을 보일지는 여기 한 곳에서만 정한다.
function syncPanes(){
  const d=!!drillKind;
  document.getElementById("chartBody").style.display=(d||tableOn)?"none":"flex";
  document.getElementById("tblview").style.display=(!d&&tableOn)?"block":"none";
  document.getElementById("drillview").style.display=d?"block":"none";
  const lg=document.querySelector(".legend");
  if(lg) lg.style.display=d?"none":"";
}

function renderDrill(){
  const conf=DRILL[drillKind]; if(!conf) return;
  const all=ordered();
  // 묶음은 고정(groups)이거나 데이터에서 만들어진다(groupsOf) — 완료 목록의 날짜별 묶음이 후자다.
  const groups=conf.groupsOf ? conf.groupsOf(all) : conf.groups;
  const picked=groups.map(g=>({g:g, rows:all.filter(g.pick)}));
  const total=picked.reduce((a,x)=>a+x.rows.length,0);
  let h='<div class="drill-head">'+
        '<button class="ghost" onclick="closeDrill()">← 차트로 돌아가기</button>'+
        '<h2>'+esc(conf.title)+'</h2><span class="cnt">'+total+'건</span></div>';
  if(!total) h+='<div class="drill-empty">해당하는 작업이 없습니다.</div>';
  picked.forEach(function(x){
    if(!x.rows.length) return;
    h+='<div class="drill-grp">'+esc(x.g.label)+'<span class="n">'+x.rows.length+'건</span></div>';
    h+='<table>'+colgroupHtml(conf.colw||COLW)+
       '<thead><tr><th>에픽</th><th>Jira</th><th>작업</th><th>담당</th><th>기간</th>'+
       (x.g.cell?'<th>'+esc(x.g.col)+'</th>':'<th>상태</th>')+'</tr></thead><tbody>';
    x.rows.forEach(function(t){
      const ep=t.epic?esc(t.epic.name):'<span style="color:var(--muted)">미분류</span>';
      const jk=t.jira?'<a class="jkey" href="'+jiraUrl(t.jira)+'" target="_blank" rel="noopener" onclick="event.stopPropagation()">'+esc(t.jira)+'</a>':'—';
      const tail = x.g.cell
        ? '<td class="why">'+x.g.cell(t)+'</td>'
        : '<td>'+stLabel(t)+'</td>';
      h+='<tr onclick="openEdit('+t.id+')" style="cursor:pointer">'+
         '<td>'+ep+'</td><td>'+jk+'</td>'+
         '<td><span class="sdot" style="background:'+STVAR[t.status]+'"></span>'+esc(t.name)+flagsHtml(t)+'</td>'+
         '<td>'+esc(ownerParts(t.owner).name)+'</td><td>'+mmdd(t.start)+'~'+mmdd(t.end)+'</td>'+tail+'</tr>';
    });
    h+='</tbody></table>';
  });
  document.getElementById("drillview").innerHTML=h;
}

function renderTable(){
  const rows=ordered();
  let h='<table><thead><tr><th>에픽</th><th>Jira</th><th>작업</th><th>담당</th><th>기간</th><th>상태</th><th>선행</th></tr></thead><tbody>';
  rows.forEach(t=>{
    const deps=(t.deps||[]).map(id=>{const p=state.tasks.find(x=>x.id===id);return p?(p.jira||p.name):"";}).filter(Boolean).join(", ");
    const blk=isBlocked(t)?' ⏳':'';
    const ep=t.epic?esc(t.epic.name):'<span style="color:var(--muted)">미분류</span>';
    const jk=t.jira?'<a class="jkey" href="'+jiraUrl(t.jira)+'" target="_blank" rel="noopener" onclick="event.stopPropagation()">'+esc(t.jira)+'</a>':'—';
    h+='<tr onclick="openEdit('+t.id+')" style="cursor:pointer">'+
       '<td>'+ep+'</td><td>'+jk+'</td>'+
       '<td><span class="sdot" style="background:'+STVAR[t.status]+'"></span>'+esc(t.name)+flagsHtml(t)+'</td>'+
       '<td>'+esc(ownerParts(t.owner).name)+'</td><td>'+mmdd(t.start)+'~'+mmdd(t.end)+'</td>'+
       '<td>'+stLabel(t)+'</td>'+
       '<td style="color:var(--muted)">'+esc(deps||'—')+'</td></tr>';
  });
  h+='</tbody></table>';
  document.getElementById("tblview").innerHTML=h;
}

/* ---------- utils ---------- */
function esc(s){return String(s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));}
function mmdd(s){const d=pd(s); return (d.getMonth()+1)+"/"+d.getDate();}

// 편집 중인 작업 id. closeEdit·openDetail 이 함께 쓴다.
// lookupIssue 보다 앞에 선언해야 한다(뒤면 TDZ).
let editingId=null;

/* ---------- Jira 이슈 불러오기 (편집본 전용) ---------- */

/* ---------- edit modal ---------- */

// 종전엔 편집본/뷰어를 가르는 디스패처였다. 편집본이 없어져 갈 곳이 하나뿐이지만,
// 인라인 onclick 이 이 이름을 부르므로 이름은 그대로 둔다.
function openEdit(id){
  return openDetail(id);
}
function closeEdit(){const o=document.getElementById("ov"); if(o) o.classList.remove("on"); editingId=null;}

/* ---------- detail panel (읽기 전용) ---------- */
function openDetail(id){
  const t=state.tasks.find(x=>x.id===id); if(!t) return;
  const jk=t.jira?'<a href="'+jiraUrl(t.jira)+'" target="_blank" rel="noopener" style="color:var(--inprog)">'+esc(t.jira)+' ↗</a>':"—";
  const ep=t.epic?esc([t.epic.key,t.epic.name].filter(Boolean).join(" · ")):"—";
  const rows=[
    ["Jira 이슈", jk],
    ["에픽", ep],
    ["담당", esc(ownerParts(t.owner).name||"—")],
    // 담당 칸에서 '시작일 미정' 같은 사유를 뗐으므로 여기서 칩으로 받아 준다.
    ["상태", '<span class="dep-st '+t.status+'">'+STICON[t.status]+'</span> '+stLabel(t)+flagsHtml(t)],
    ["기간", mmdd(t.start)+" ~ "+mmdd(t.end)],
    ["선행 작업", depDetailHtml(t)],
    ["후행 작업", succDetailHtml(t)],
  ];
  document.getElementById("dTitle").textContent=t.name;
  document.getElementById("dBody").innerHTML=rows.map(r=>
    '<div class="drow"><span class="dk">'+r[0]+'</span><span class="dv">'+r[1]+'</span></div>').join("");
  document.getElementById("ovD").classList.add("on");
}

// 뷰어의 '선행 작업'은 지정된 선행만 보여주되, 각각의 현재 상태를 함께 읽게 한다.
// 선행·후행 한 항목의 공통 렌더. 이름은 자기 줄을 통째로 쓰고(자르지 않는다),
// Jira 키와 부가정보는 아래 메타 줄로 내린다 — 좌측 라벨 행과 같은 패턴이다.
function depItemHtml(x, metaTail){
  const jk = x.jira
    ? '<a class="dep-jk" href="'+jiraUrl(x.jira)+'" target="_blank" rel="noopener">'+esc(x.jira)+'</a> · '
    : "";
  return '<div class="dep-item">'+
    '<span class="dep-st '+x.status+'">'+STICON[x.status]+'</span>'+
    '<div class="dep-body">'+
      '<div class="dep-nm">'+esc(x.name)+'</div>'+
      '<div class="dep-meta">'+jk+metaTail+'</div>'+
    '</div>'+
  '</div>';
}
function depDetailHtml(t){
  const deps=(t.deps||[]).map(d=>state.tasks.find(x=>x.id===d)).filter(Boolean);
  if(!deps.length) return '<span style="color:var(--muted)">없음</span>';
  const head=isBlocked(t)?'<div class="dep-warn">선행 작업이 완료되지 않아 대기 상태입니다</div>':"";
  return head+deps.map(function(p){
    return depItemHtml(p, stLabel(p));
  }).join("");
}
// 후행 작업 = 이 작업을 선행으로 지정한 작업들. deps 는 후행 쪽에만 기록되므로
// 역방향은 전체를 훑어야 알 수 있다.
function successorsOf(tasks, id){
  return tasks.filter(x => (x.deps||[]).indexOf(id) !== -1);
}
function succDetailHtml(t){
  const succ=successorsOf(state.tasks, t.id);
  if(!succ.length) return '<span style="color:var(--muted)">없음</span>';
  return succ.map(function(s){
    return depItemHtml(s, mmdd(s.start)+" 시작"+(s.owner?" · "+esc(s.owner):""));
  }).join("");
}
function closeDetail(){document.getElementById("ovD").classList.remove("on");}
document.getElementById("ovD").addEventListener("click",e=>{if(e.target.id==="ovD")closeDetail();});

/* ---------- toolbar actions ---------- */

const TOP_LEFT_VIEW =
  '<div class="title-txt" id="titleTxt"></div>' +
  '<div class="dl-field" style="margin-top:6px;"><span>🎯 마감일</span><b id="deadlineTxt"></b></div>' +
  '<div class="dl-field" style="margin-top:6px;"><span id="winTxt"></span></div>';
const TOP_BTNS_VIEW =
  '<button class="ghost" id="viewBtn" onclick="toggleView()">표로 보기</button>' +
  '<button class="ghost" id="allBtn" onclick="toggleAllEpics()">전체 펼치기</button>' +
  '<button class="ghost" id="txtBtn" onclick="toggleBarText()">글자 전체</button>' +
  '<button class="ghost" onclick="toggleTheme()" id="thBtn">🌙 다크</button>';

// 부팅 때 한 번만. 편집본은 입력에 포커스가 살아 있어야 하므로 재빌드하지 않는다.
function buildTop(){
  // TOP_*_EDIT 는 EDIT-ONLY 구간에서 선언되므로 뷰어 산출물에는 아예 없다.
  // 삼항 연산자로 참조하면 문법·파싱은 통과하지만(미평가 분기) 심볼이 뷰어에 남아
  // 조건 한 줄만 바뀌어도 ReferenceError 로 백지가 된다. 참조 자체를 마커 안에 둔다.
  let left = TOP_LEFT_VIEW, btns = TOP_BTNS_VIEW;
  
  document.getElementById("topLeft").innerHTML = left;
  document.getElementById("topBtns").innerHTML = btns;
  
}

// render() 가 매번 부른다.
function syncTop(){
  // 모드와 무관한 공통 토글 라벨부터. (아래 편집 분기는 return 하므로 여기가 먼저다)
  const tb = document.getElementById("txtBtn");
  if(tb) tb.textContent = barTextIsFull() ? "글자 줄임" : "글자 전체";
  const ab = document.getElementById("allBtn");
  if(ab) ab.textContent = allEpicsExpanded() ? "전체 접기" : "전체 펼치기";
  
  document.getElementById("titleTxt").textContent = state.title;
  document.getElementById("deadlineTxt").textContent = state.deadline;
  const w = state.window;
  document.getElementById("winTxt").textContent =
    (w && w.on) ? ("📅 표시 범위 " + w.start + " ~ " + w.end) : "📅 표시 범위 자동";
}

let tableOn=false;
function toggleView(){
  tableOn=!tableOn;
  syncPanes();
  document.getElementById("viewBtn").textContent=tableOn?"간트로 보기":"표로 보기";
}
function toggleTheme(){
  const h=document.documentElement;
  const dark=h.getAttribute("data-theme")==="dark";
  h.setAttribute("data-theme",dark?"light":"dark");
  document.getElementById("thBtn").textContent=dark?"🌙 다크":"☀️ 라이트";
}

// 데이터가 없으면 그릴 것이 없다. 그래서 fetch 가 끝난 뒤에야 화면을 세운다 —
// 빈 차트를 먼저 그렸다가 채우면 그 순간이 '데이터 없음'으로 읽힌다.
// data.json 을 못 읽으면 되는 척하지 않고 무엇이 잘못됐는지 그대로 적는다.
async function boot(){
  try{
    const res = await fetch(DATA_URL, {cache:"no-cache"});
    if(!res.ok) throw new Error("HTTP "+res.status);
    state = await res.json();
    if(!state || !Array.isArray(state.tasks)) throw new Error("tasks 배열이 없습니다");
  }catch(e){
    setLoading(false);
    showSyncNote("차트 데이터를 불러오지 못했습니다 ("+(e.message||e)+")", true);
    return;
  }
  buildTop();
  applyLabelWidth();
  initResizer();
  // 뷰어의 첫 그리기는 syncFromJira 안에서만 일어난다 — 저장된 값이 잠깐 보였다 바뀌면
  // 그게 진짜 값인 줄 안다. 실패해도 finally 에서 반드시 그린다.
  syncFromJira();
}

boot();
