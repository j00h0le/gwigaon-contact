// 귀가온 trusted-contact page. Token comes from the URL fragment (#t=…), which browsers
// never send to a server. Flow: anonymous sign-in → join_trip(token) → load → Realtime.
import {
  deriveView,
  eventMeta,
  mapLink,
  mergeEvents,
  relativeKo,
  tokenFromHash,
} from "./state.js";

const REFRESH_TICK_MS = 5_000; // re-derive "interrupted" from last_seen_at
const RESYNC_MS = 30_000; // safety refetch in case a Realtime message was missed

const $ = (id) => document.getElementById(id);
const timeFmt = new Intl.DateTimeFormat("ko-KR", {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Asia/Seoul",
});

const state = { tripId: null, trip: null, events: [], report: null, seenSeqs: new Set() };
let client = null;
let channel = null;

function show(sectionId) {
  for (const id of ["loading", "invalid", "error", "trip"]) $(id).hidden = id !== sectionId;
}

function fail(message) {
  console.error("[contact]", message);
  $("error-text").textContent = "네트워크 상태를 확인한 뒤 다시 시도해 주세요.";
  show("error");
}

async function start() {
  show("loading");
  const token = tokenFromHash(location.hash);
  if (!token) return show("invalid");

  const cfg = window.GWIGAON_CONFIG;
  if (!client) {
    client = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
    });
  }

  const { data: sessionData } = await client.auth.getSession();
  if (!sessionData.session) {
    const { error } = await client.auth.signInAnonymously();
    if (error) return fail(`sign-in: ${error.message}`);
  }

  const { data: tripId, error: joinError } = await client.rpc("join_trip", { token });
  if (joinError) return fail(`join_trip: ${joinError.message}`);
  if (!tripId) return show("invalid");
  state.tripId = tripId;

  if (!(await loadAll())) return;
  show("trip");
  render();
  subscribe();
}

/** quiet: background resync — log errors, keep showing the last good state. */
async function loadAll({ quiet = false } = {}) {
  const id = state.tripId;
  const [tripRes, eventsRes, reportRes] = await Promise.all([
    client.from("trips").select("id,status,destination_label,started_at,ended_at,last_seen_at").eq("id", id).single(),
    client.from("trip_events").select("seq,type,occurred_at,lat,lng,reason,payload").eq("trip_id", id).order("seq"),
    client.from("trip_reports").select("summary,model,created_at").eq("trip_id", id).maybeSingle(),
  ]);
  const err = tripRes.error ?? eventsRes.error ?? reportRes.error;
  if (err) {
    if (quiet) console.warn("[contact] resync failed:", err.message);
    else fail(`load: ${err.message}`);
    return false;
  }
  state.trip = tripRes.data;
  state.events = mergeEvents(state.events, eventsRes.data);
  state.report = reportRes.data;
  return true;
}

function subscribe() {
  if (channel) client.removeChannel(channel);
  const id = state.tripId;
  channel = client
    .channel(`trip-${id}`)
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "trip_events", filter: `trip_id=eq.${id}` },
      (msg) => {
        state.events = mergeEvents(state.events, [msg.new]);
        render();
      })
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "trips", filter: `id=eq.${id}` },
      (msg) => {
        state.trip = { ...state.trip, ...msg.new };
        render();
      })
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "trip_reports", filter: `trip_id=eq.${id}` },
      (msg) => {
        state.report = msg.new;
        render();
      })
    .subscribe(async (status) => {
      if (status === "SUBSCRIBED") {
        // Close the gap between the initial load and the subscription going live.
        if (await loadAll({ quiet: true })) render();
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        console.warn("[contact] realtime", status);
      }
    });
}

function render() {
  const { trip, events, report } = state;
  if (!trip) return;
  const view = deriveView(trip, events, Date.now());

  $("destination").textContent = trip.destination_label || "목적지 미지정";
  const status = $("status");
  status.dataset.tone = view.status.tone;
  $("status-text").textContent = view.status.text;
  $("last-seen").textContent = view.ended ? `운행 종료 (${timeFmt.format(new Date(trip.ended_at ?? trip.last_seen_at))})` : relativeKo(view.silentMs);
  renderLocation(view.location);
  renderBanners(view);
  renderTimeline(events);
  renderReport(report);
  document.title = `귀가온 · ${view.status.text}`;
}

function renderLocation(e) {
  const dd = $("location");
  dd.replaceChildren();
  if (!e) {
    dd.textContent = "아직 없음";
    return;
  }
  const a = document.createElement("a");
  a.href = mapLink(e.lat, e.lng);
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.textContent = "지도에서 보기";
  dd.append(`${e.lat.toFixed(4)}, ${e.lng.toFixed(4)} · ${timeFmt.format(new Date(e.occurred_at))} 기준 `, a);
}

function banner(tone, title, lines, actions = []) {
  const el = document.createElement("section");
  el.className = "banner";
  el.dataset.tone = tone;
  el.setAttribute("role", tone === "danger" ? "alert" : "status");
  const h = document.createElement("h2");
  h.textContent = title;
  el.append(h);
  for (const line of lines.filter(Boolean)) {
    const p = document.createElement("p");
    p.textContent = line;
    el.append(p);
  }
  if (actions.length) {
    const row = document.createElement("div");
    row.className = "actions";
    for (const { href, label, primary } of actions) {
      const a = document.createElement("a");
      a.className = primary ? "btn primary" : "btn";
      a.href = href;
      a.textContent = label;
      if (href.startsWith("http")) {
        a.target = "_blank";
        a.rel = "noopener noreferrer";
      }
      row.append(a);
    }
    el.append(row);
  }
  return el;
}

function renderBanners(view) {
  const out = [];
  for (const b of view.banners) {
    const e = b.event;
    const at = e ? `${timeFmt.format(new Date(e.occurred_at))} 발생` : null;
    const where = e && typeof e.lat === "number" ? [{ href: mapLink(e.lat, e.lng), label: "위치 보기" }] : [];
    if (b.kind === "sos") {
      out.push(banner("danger", "SOS 비상 신호", [e.reason, at, "차량 안에서 SOS가 눌렸어요. 연락이 닿지 않으면 112 또는 119에 신고하세요."],
        [{ href: "tel:112", label: "112 전화", primary: true }, { href: "tel:119", label: "119 전화" }, ...where]));
    } else if (b.kind === "safe_check") {
      out.push(banner("danger", "도착 후 승객이 아직 하차하지 않았어요", [e.reason, at, "기사님이 승객 상태를 확인하고 있어요. 승객에게 연락해 보세요."], where));
    } else if (b.kind === "interrupted") {
      out.push(banner("warn", "모니터링 중단됨", [
        e?.reason ?? null,
        `마지막 신호: ${relativeKo(b.silentMs)}`,
        "차량 앱과의 연결이 끊겼어요. 통신 상태 때문일 수 있어요.",
      ]));
    } else if (b.kind === "arrived") {
      out.push(banner("ok", "안전하게 도착했어요", ["승객 하차가 확인됐어요."]));
    }
  }
  $("banners").replaceChildren(...out);
}

function renderTimeline(events) {
  const tpl = $("tpl-event");
  const items = [...events].reverse().map((e) => {
    const li = tpl.content.firstElementChild.cloneNode(true);
    const meta = eventMeta(e.type, e.payload);
    li.dataset.tone = meta.tone;
    li.querySelector(".event-label").textContent = meta.label;
    const t = li.querySelector(".event-time");
    t.dateTime = e.occurred_at;
    t.textContent = timeFmt.format(new Date(e.occurred_at));
    li.querySelector(".event-reason").textContent = e.reason ?? "";
    if (state.seenSeqs.size && !state.seenSeqs.has(e.seq)) li.classList.add("fresh");
    return li;
  });
  for (const e of events) state.seenSeqs.add(e.seq);
  if (!items.length) {
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = "아직 기록이 없어요.";
    items.push(li);
  }
  $("timeline").replaceChildren(...items);
}

function renderReport(report) {
  const section = $("report");
  const s = report?.summary;
  if (!s || typeof s.summary !== "string") {
    section.hidden = true;
    return;
  }
  section.hidden = false;
  $("report-summary").textContent = s.summary;
  const li = (text) => {
    const el = document.createElement("li");
    el.textContent = text;
    return el;
  };
  $("report-notable").replaceChildren(...(s.notable_events ?? []).map((n) => li(`• ${n.text}`)));
  $("report-caveats").replaceChildren(...(s.caveats ?? []).map((c) => li(`참고: ${c}`)));
}

$("retry").addEventListener("click", () => start());
window.addEventListener("hashchange", () => location.reload());
document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState === "visible" && state.tripId && (await loadAll({ quiet: true }))) render();
});
setInterval(() => state.trip && render(), REFRESH_TICK_MS);
setInterval(async () => {
  if (state.tripId && document.visibilityState === "visible" && (await loadAll({ quiet: true }))) render();
}, RESYNC_MS);

start().catch((e) => fail(e?.message ?? String(e)));
