// Pure view-state derivation for the contact page. No DOM, no network, no clock reads:
// `now` is passed in so this can be tested with `deno test web/contact/`.

export const INTERRUPTED_AFTER_MS = 90_000;

/** Korean label and severity per event wire name (TripEvent, SCREAMING_SNAKE). */
export const EVENT_META = {
  TRIP_STARTED: { label: "운행 시작", tone: "neutral" },
  ROUTE_DEVIATION: { label: "경로 이탈", tone: "warn" },
  DEVIATION_CLEARED: { label: "경로 복귀", tone: "ok" },
  LONG_STOP: { label: "장시간 정차", tone: "warn" },
  LONG_STOP_CLEARED: { label: "다시 출발", tone: "ok" },
  SOS: { label: "SOS 비상 신호", tone: "danger" },
  SOS_CANCELLED: { label: "SOS 취소 (오작동)", tone: "neutral" },
  MONITORING_INTERRUPTED: { label: "모니터링 중단", tone: "warn" },
  MONITORING_RESUMED: { label: "모니터링 재개", tone: "ok" },
  NEAR_DESTINATION: { label: "목적지 근처 도착", tone: "neutral" },
  ARRIVED: { label: "목적지 도착", tone: "ok" },
  SAFE_ARRIVAL_CHECK_OPENED: { label: "승객 하차 확인 필요", tone: "danger" },
  SAFE_ARRIVAL_CONFIRMED: { label: "안전 하차 확인", tone: "ok" },
  CHECK_IN_PROMPTED: { label: "상태 확인 요청", tone: "warn" },
  CHECK_IN_ANSWERED: { label: "상태 확인 응답", tone: "ok" },
  TRIP_ENDED: { label: "운행 종료", tone: "neutral" },
  PIN_LOCKOUT: { label: "PIN 잠김 (여러 번 틀림)", tone: "warn" },
};

/** A driver's "승객 반응 있음" is not a safe arrival: the trip waits for the passenger to get out (ADR 0007). */
const isDriverConfirmation = (e) =>
  e.type === "SAFE_ARRIVAL_CONFIRMED" && e.payload?.closed_by === "driver_confirmed";

export function eventMeta(type, payload) {
  if (type === "SAFE_ARRIVAL_CONFIRMED" && payload?.closed_by === "driver_confirmed") {
    return { label: "기사 확인 (하차 전)", tone: "warn" };
  }
  return EVENT_META[type] ?? { label: type, tone: "neutral" };
}

/** Sorts by seq and drops duplicate seqs (Realtime + refetch can deliver the same row twice). */
export function mergeEvents(existing, incoming) {
  const bySeq = new Map();
  for (const e of [...existing, ...incoming]) bySeq.set(e.seq, e);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

/** Latest event of `openType` that has no later `closeType`, or null. */
function openEpisode(events, openType, closeType) {
  let open = null;
  for (const e of events) {
    if (e.type === openType) open = e;
    else if (e.type === closeType) open = null;
  }
  return open;
}

function lastLocated(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (typeof e.lat === "number" && typeof e.lng === "number") return e;
  }
  return null;
}

/**
 * @param {object} trip  row from public.trips
 * @param {object[]} events rows from public.trip_events, sorted by seq
 * @param {number} now epoch ms
 */
export function deriveView(trip, events, now) {
  const ended = trip.status === "ended" || events.some((e) => e.type === "TRIP_ENDED");
  const sos = openEpisode(events, "SOS", "SOS_CANCELLED");
  const safeCheck = openEpisode(events, "SAFE_ARRIVAL_CHECK_OPENED", "SAFE_ARRIVAL_CONFIRMED");
  const deviation = openEpisode(events, "ROUTE_DEVIATION", "DEVIATION_CLEARED");
  const longStop = openEpisode(events, "LONG_STOP", "LONG_STOP_CLEARED");
  const interruptedEvent = openEpisode(events, "MONITORING_INTERRUPTED", "MONITORING_RESUMED");
  const lastSeenMs = trip.last_seen_at ? Date.parse(trip.last_seen_at) : NaN;
  const silentMs = Number.isNaN(lastSeenMs) ? Infinity : now - lastSeenMs;
  const interrupted = !ended && (silentMs > INTERRUPTED_AFTER_MS || interruptedEvent !== null);
  const safeArrived = events.some((e) => e.type === "SAFE_ARRIVAL_CONFIRMED" && !isDriverConfirmation(e)) ||
    events.some((e) => e.type === "TRIP_ENDED" && e.payload?.reason === "safe_arrival");
  const waitingForPassenger = !ended && !safeArrived && events.some(isDriverConfirmation);

  /** Big banners, most urgent first. */
  const banners = [];
  if (sos) banners.push({ kind: "sos", event: sos });
  if (safeCheck && !ended) banners.push({ kind: "safe_check", event: safeCheck });
  if (interrupted) banners.push({ kind: "interrupted", event: interruptedEvent, silentMs });
  if (ended && safeArrived && !sos) banners.push({ kind: "arrived" });

  let status;
  if (sos) status = { text: "SOS 비상 신호 발생", tone: "danger" };
  else if (safeCheck && !ended) status = { text: "도착 후 하차 확인 중", tone: "danger" };
  else if (waitingForPassenger) status = { text: "기사가 승객 반응 확인 · 하차 대기 중", tone: "warn" };
  else if (ended) status = safeArrived
    ? { text: "안전하게 도착했어요", tone: "ok" }
    : { text: "운행 종료", tone: "neutral" };
  else if (interrupted) status = { text: "모니터링 중단됨", tone: "warn" };
  else if (deviation) status = { text: "경로 이탈 중", tone: "warn" };
  else if (longStop) status = { text: "장시간 정차 중", tone: "warn" };
  else if (events.some((e) => e.type === "ARRIVED")) status = { text: "목적지 도착", tone: "ok" };
  else if (trip.status === "arriving" || events.some((e) => e.type === "NEAR_DESTINATION")) {
    status = { text: "목적지 근처", tone: "neutral" };
  } else status = { text: "정상 운행 중", tone: "ok" };

  return { ended, status, banners, location: lastLocated(events), silentMs };
}

/** Map link for a location (Kakao Map, works on phones without an app). */
export function mapLink(lat, lng) {
  return `https://map.kakao.com/link/map/${encodeURIComponent("마지막 위치")},${lat},${lng}`;
}

export function relativeKo(ms) {
  if (!Number.isFinite(ms)) return "알 수 없음";
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return "방금 전";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}분 전`;
  const h = Math.floor(m / 60);
  return `${h}시간 ${m % 60}분 전`;
}

/** Reads `t` from a URL fragment like `#t=abc`. Never from the query string. */
export function tokenFromHash(hash) {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const t = params.get("t");
  return t && /^[A-Za-z0-9_-]{22,}$/.test(t) ? t : null;
}
