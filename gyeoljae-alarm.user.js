// ==UserScript==
// @name         업무포털 결재 알림
// @namespace    gne-eduptl-alarm
// @version      2.1
// @description  업무포털 메인 화면을 1분마다 확인해 결재·메모·메일 등이 있으면 PC 음성 안내(조용한 시간·공휴일 제외) + 휴대폰(ntfy) 알림(새로 생겼을 때 한 번)
// @match        https://gne.eduptl.kr/bpm_man_mn00_001.do*
// @grant        none
// @run-at       document-idle
// @updateURL    https://guronsanbamond.github.io/gyeoljae_alarm/gyeoljae-alarm.user.js
// @downloadURL  https://guronsanbamond.github.io/gyeoljae_alarm/gyeoljae-alarm.user.js
// ==/UserScript==

(function () {
  'use strict';
  if (document.getElementById('__monbox')) return; // 이미 실행 중이면 두 번 돌지 않음

  // ===== 설정 (숫자만 바꾸면 됩니다) =====
  // 휴대폰 ntfy 채널 이름은 코드에 적지 않습니다.
  // 처음 실행하면 오른쪽 아래 상자에 입력 칸이 뜨고, 입력한 이름은 이 PC 크롬에 따로 보관됩니다.
  // 그래서 자동 업데이트가 되어도 채널 이름은 지워지지 않습니다.
  const CHECK_MIN = 1;          // 확인 간격(분)
  const EXTEND_UNDER_MIN = 10;  // 남은 로그인 시간이 이보다 적으면 자동 연장(분)
  const QUIET_START = 20;       // PC 음성 끄는 시작 시각 (20시)
  const QUIET_END = 7;          // PC 음성 다시 켜는 시각 (7시)
  const QUIET_WEEKEND = true;   // 토·일 내내 PC 음성 끔
  const QUIET_HOLIDAY = true;   // 공휴일(대체공휴일 포함) 내내 PC 음성 끔
  // =====================================

  // ===== 공휴일 자동 계산 (해마다 손댈 필요 없음) =====
  // 설날·부처님오신날·추석은 크롬의 음력 계산 기능으로 구하고, 대체공휴일 규칙도 적용합니다.
  const _holCache = {};
  function ymd(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function holidaysOf(Y) {
    if (_holCache[Y]) return _holCache[Y];
    const fmt = new Intl.DateTimeFormat('en-u-ca-chinese', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric' });
    const lunarDay = {}; // '1-1' → 양력 날짜
    for (let d = new Date(Y, 0, 1); d.getFullYear() === Y; d.setDate(d.getDate() + 1)) {
      const p = {};
      fmt.formatToParts(d).forEach(x => { p[x.type] = x.value; });
      if (/^\d+$/.test(p.month)) lunarDay[p.month + '-' + p.day] = new Date(d);
    }
    const shift = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
    const list = []; // [날짜, 대체 규칙] — W: 토·일·겹침 시 대체, S: 일요일·겹침 시 대체, N: 대체 없음
    const add = (d, rule) => { if (d) list.push([d, rule]); };
    add(new Date(Y, 0, 1), 'N');                 // 신정
    add(new Date(Y, 2, 1), 'W');                 // 삼일절
    add(new Date(Y, 4, 5), 'W');                 // 어린이날
    add(new Date(Y, 5, 6), 'N');                 // 현충일
    add(new Date(Y, 6, 17), 'W');                // 제헌절
    add(new Date(Y, 7, 15), 'W');                // 광복절
    add(new Date(Y, 9, 3), 'W');                 // 개천절
    add(new Date(Y, 9, 9), 'W');                 // 한글날
    add(new Date(Y, 11, 25), 'W');               // 성탄절
    const seol = lunarDay['1-1'], chu = lunarDay['8-15'];
    if (seol) [-1, 0, 1].forEach(n => add(shift(seol, n), 'S'));   // 설날 연휴
    add(lunarDay['4-8'], 'W');                   // 부처님오신날
    if (chu) [-1, 0, 1].forEach(n => add(shift(chu, n), 'S'));     // 추석 연휴
    list.sort((a, b) => a[0] - b[0]);

    const set = new Set(), seen = {};
    let need = []; // 대체공휴일이 필요한 원래 날짜
    list.forEach(([d, rule]) => {
      const k = ymd(d), w = d.getDay();
      const overlap = seen[k];
      seen[k] = true;
      set.add(k);
      if (rule === 'N') return;
      if (overlap || w === 0 || (rule === 'W' && w === 6)) need.push(d);
    });
    // 대체공휴일: 설·추석은 연휴가 끝난 뒤, 나머지는 그날 다음의 첫 평일(공휴일 아닌 날)
    need.forEach(d => {
      let x = new Date(d);
      do { x = shift(x, 1); } while (x.getDay() === 0 || x.getDay() === 6 || set.has(ymd(x)));
      set.add(ymd(x));
    });
    return (_holCache[Y] = set);
  }
  function holiday() {
    const d = new Date();
    try { return QUIET_HOLIDAY && holidaysOf(d.getFullYear()).has(ymd(d)); } catch (e) { return false; }
  }

  // 지금이 조용한 시간인지 확인
  function quiet() {
    const d = new Date(), h = d.getHours(), w = d.getDay();
    return (QUIET_WEEKEND && (w === 0 || w === 6)) || holiday() || h >= QUIET_START || h < QUIET_END;
  }

  // 화면에서 항목 값 읽기
  function val(label) {
    const li = [...document.querySelectorAll('.mct-top-area li')]
      .find(l => l.innerText.replace(/\s+/g, ' ').trim().startsWith(label));
    return li ? li.innerText.replace(label, '').replace(/\s+/g, '').trim() : '';
  }

  // "3(1)" 형태를 [3, 1]로
  function pair(v) {
    const m = (v || '').match(/(\d+)\((\d+)\)/);
    return m ? [+m[1], +m[2]] : [0, 0];
  }

  // PC 음성 안내 (조용한 시간에는 안 함)
  function say(t) {
    if (quiet()) return;
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(t);
      u.lang = 'ko-KR';
      speechSynthesis.speak(u);
    } catch (e) {}
  }

  let status = '-', lastExt = '-', lastPush = '-', lastCheck = '-', warned = false, prev = {};
  let timerCheck = null, timerSession = null;
  let paused = false;   // [중지]를 누르면 true
  let cur = {};         // 마지막으로 읽은 건수
  let unacked = [];     // 아직 [확인했음]을 누르지 않은 항목

  // [확인했음]을 누른 건수 기억 (새로고침해도 유지)
  let ack = {};
  try { ack = JSON.parse(localStorage.getItem('gyeoljae-ack') || '{}'); } catch (e) {}
  function saveAck() { try { localStorage.setItem('gyeoljae-ack', JSON.stringify(ack)); } catch (e) {} }

  // 휴대폰 채널 이름 보관
  let topic = '';
  try { topic = localStorage.getItem('gyeoljae-topic') || ''; } catch (e) {}
  function cleanTopic(t) {
    t = (t || '').trim().replace(/^https?:\/\/ntfy\.sh\//i, '').replace(/\/+$/, '');
    return /^[A-Za-z0-9_-]{1,64}$/.test(t) ? t : '';
  }

  // 휴대폰 알림 (시간 제한 없음)
  function push(msg) {
    if (!topic) { lastPush = '채널 이름 미설정'; render(); return; }
    fetch('https://ntfy.sh/' + topic, {
      method: 'POST',
      headers: { 'Priority': 'urgent', 'Tags': 'bell' },
      body: msg
    }).then(r => {
      lastPush = new Date().toLocaleTimeString('ko-KR') + (r.ok ? ' 전송' : ' 실패');
      render();
    }).catch(() => { lastPush = '전송 실패'; render(); });
  }

  // 남은 로그인 시간(초)
  function left() {
    const m = document.body.innerText.match(/(\d+):(\d+)\s*후에\s*로그아웃/);
    return m ? (+m[1]) * 60 + (+m[2]) : null;
  }

  // 오른쪽 아래 상태 상자
  const box = document.createElement('div');
  box.id = '__monbox';
  box.style.cssText = 'position:fixed;right:110px;bottom:20px;z-index:99999;background:#222;color:#fff;padding:10px 14px;border-radius:8px;font-size:13px;line-height:1.5;box-shadow:0 2px 8px #0008';
  const info = document.createElement('div');
  const setup = document.createElement('div');
  setup.style.cssText = 'margin-top:8px;padding-top:8px;border-top:1px solid #555';
  setup.innerHTML =
    '<div style="color:#ffd54a;font-weight:700">📱 휴대폰 채널 이름을 넣어 주세요</div>' +
    '<div style="font-size:12px;color:#ccc">이름이 틀리면 휴대폰에 알림이 오지 않습니다.</div>' +
    '<div style="font-size:12px;color:#ccc">휴대폰 ntfy 앱에 보이는 이름을 그대로 붙여 넣고 [저장]</div>' +
    '<input id="__montopic" type="text" placeholder="예: gne-gyeoljae-ab12cd3" autocomplete="off" ' +
    'style="margin-top:4px;width:220px;padding:3px 6px;border-radius:3px;border:1px solid #999;font-size:12px;color:#111;background:#fff">' +
    '<button data-act="savetopic" style="margin-left:4px;padding:2px 8px;border-radius:3px;border:1px solid #c9a400;background:#ffd54a;color:#111;cursor:pointer;font-size:12px;font-weight:700">저장</button>' +
    '<button data-act="closetopic" style="margin-left:4px;padding:2px 8px;border-radius:3px;border:1px solid #999;background:#eee;color:#111;cursor:pointer;font-size:12px">닫기</button>' +
    '<div id="__monmsg" style="font-size:12px;color:#ff8a80"></div>';
  box.appendChild(info);
  box.appendChild(setup);
  document.body.appendChild(box);
  function showSetup(on) {
    setup.hidden = !on;
    setup.style.display = on ? '' : 'none';
    const m = document.getElementById('__monmsg'); if (m) m.textContent = '';
    if (on) { const i = document.getElementById('__montopic'); if (i) i.value = topic; }
  }
  showSetup(!topic);

  const BTN = 'margin-top:6px;margin-right:6px;padding:2px 8px;border-radius:3px;border:1px solid #999;background:#eee;color:#111;cursor:pointer;font-size:12px';
  function render() {
    let mode;
    if (paused) mode = '⏸ 멈춤 (알림·로그인 연장 꺼짐)';
    else if (quiet()) mode = holiday() ? '🌙 공휴일 (음성 꺼짐, 휴대폰만)' : '🌙 조용한 시간 (음성 꺼짐, 휴대폰만)';
    else if (status !== '해당 없음' && status !== '-' && !unacked.length) mode = '🔕 확인한 알림 (음성 꺼짐)';
    else mode = '🔔 결재 알림 작동 중 (음성+휴대폰)';
    let btns = '';
    if (!paused && unacked.length)
      btns += '<button data-act="ack" style="' + BTN + ';background:#ffd54a;border-color:#c9a400;font-weight:700">확인했음 (음성 끄기)</button>';
    btns += paused
      ? '<button data-act="resume" style="' + BTN + ';background:#7fd6b4;border-color:#3a9;font-weight:700">다시 시작</button>'
      : '<button data-act="stop" style="' + BTN + '">중지</button>';
    info.innerHTML = mode +
      '<br>마지막 확인: ' + lastCheck +
      '<br>' + status +
      '<br>로그인 연장: ' + lastExt +
      '<br>휴대폰 알림: ' + lastPush +
      (topic && setup.hidden ? ' <span data-act="settopic" style="color:#aaa;font-size:11px;text-decoration:underline;cursor:pointer">(휴대폰에 안 오면 누르세요)</span>' : '') +
      '<br>' + btns;
  }

  box.addEventListener('click', e => {
    const act = e.target.dataset && e.target.dataset.act;
    if (!act) return;
    if (act === 'savetopic') {     // 채널 이름 저장
      const t = cleanTopic(document.getElementById('__montopic').value);
      if (!t) { document.getElementById('__monmsg').textContent = '영어·숫자·하이픈(-)만 쓸 수 있습니다. 다시 확인해 주세요.'; return; }
      topic = t;
      try { localStorage.setItem('gyeoljae-topic', topic); } catch (e) {}
      showSetup(false);
      fetch('https://ntfy.sh/' + topic, { method: 'POST', headers: { 'Tags': 'white_check_mark' }, body: '결재 알림이 연결되었습니다.' })
        .then(r => { lastPush = new Date().toLocaleTimeString('ko-KR') + (r.ok ? ' 연결 시험 전송' : ' 실패'); render(); })
        .catch(() => { lastPush = '전송 실패'; render(); });
    } else if (act === 'settopic') {
      showSetup(true);
    } else if (act === 'closetopic') {
      if (topic) showSetup(false);
    } else if (act === 'ack') {           // 지금 건수까지는 확인한 것으로 기억
      ack = Object.assign({}, cur);
      saveAck();
      unacked = [];
      speechSynthesis.cancel();
      status = status.replace(/<\/?b[^>]*>/g, '').replace('알림: ', '') + ' <span style="color:#7fd6b4">· 확인함</span>';
    } else if (act === 'stop') {   // 모두 멈춤
      paused = true;
      speechSynthesis.cancel();
    } else if (act === 'resume') { // 다시 시작
      paused = false;
      run();
      session();
    }
    render();
  });

  // 로그인 유지 확인
  function session() {
    if (paused) return;
    const l = left();
    if ((l === null || l <= 90) && !warned) {
      const w = '곧 로그아웃됩니다. 업무포털을 확인해 주세요.';
      say(w);
      push(w);
      warned = true;
    }
    if (l !== null && l < EXTEND_UNDER_MIN * 60) {
      document.querySelector('.session-info .btn-refresh')?.click();
      lastExt = new Date().toLocaleTimeString('ko-KR');
      setTimeout(() => {
        const n = left();
        if (n !== null && n > l) warned = false;
      }, 3000);
    }
    render();
  }

  // "세션종료까지 ... 연장하시겠습니까?" 창이 뜨면 자동으로 [확인] 누르기
  function autoConfirm() {
    if (paused) return;
    const msg = document.getElementById('swal2-html-container');
    if (!msg || !/세션종료까지[\s\S]*연장/.test(msg.innerText || '')) return;
    const btn = document.querySelector('.swal2-popup .swal2-confirm');
    if (btn && btn.offsetParent !== null) {
      btn.click();
      lastExt = new Date().toLocaleTimeString('ko-KR') + ' (창 확인)';
      warned = false;
      render();
    }
  }

  // 결재 등 확인
  function check() {
    const [a, ae] = pair(val('결재(긴급)'));
    const [b, be] = pair(val('메모(긴급)'));
    let ds = 0;
    ['내부승인(요청)', '카드권한(요청)', '데이터취합(내담당)', '내부승인(처리)', '카드권한(처리)', '설문']
      .forEach(k => { ds += parseInt(val(k)) || 0; });

    cur = {
      '나이스 미결/협조': parseInt(val('미결/협조함')) || 0,
      '결재': a,
      '긴급 결재': ae,
      '메모': b,
      '긴급 메모': be,
      '메일': parseInt(val('메일')) || 0,
      '데이터통합관리 알림': ds
    };

    const words = Object.entries(cur).filter(([k, v]) => v > 0).map(([k, v]) => k + ' ' + v + '건');
    const isNew = Object.keys(cur).some(k => cur[k] > (prev[k] || 0));
    prev = cur;

    lastCheck = new Date().toLocaleTimeString('ko-KR');
    // 처리해서 줄어든 건은 확인 기록도 같이 줄임
    Object.keys(ack).forEach(k => { if ((cur[k] || 0) < ack[k]) ack[k] = cur[k] || 0; });
    saveAck();
    unacked = Object.keys(cur).filter(k => cur[k] > (ack[k] || 0));

    if (!words.length) status = '해당 없음';
    else if (unacked.length) status = '<b style="color:#ff6">알림: ' + words.join(', ') + '</b>';
    else status = words.join(', ') + ' <span style="color:#7fd6b4">· 확인함</span>';
    render();

    if (words.length) {
      if (unacked.length) say(words.join(', ') + '이 있습니다. 확인해 주세요.');           // PC: 1분마다 (조용한 시간·공휴일 제외)
      if (isNew) push('업무포털: ' + words.join(', ') + '이 있습니다.'); // 휴대폰: 새로 생겼을 때 한 번
    }
  }

  function run() {
    if (paused) return;
    ['btnRefreshNeisAprvWork', 'btnRefreshKedu', 'btnRefreshEdmgr']
      .forEach(id => document.getElementById(id)?.click());
    setTimeout(check, 5000);
  }

  render();
  setTimeout(() => {
    timerCheck = setInterval(run, CHECK_MIN * 60 * 1000);
    timerSession = setInterval(session, 30 * 1000);
    setInterval(autoConfirm, 2000); // 2초마다 연장 창 확인
    run();
    session();
  }, 5000); // 화면이 다 뜬 뒤 시작
})();
