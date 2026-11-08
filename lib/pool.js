/**
 * Routing-id pool.
 *
 * A DSH session that goes idle or is archived offers its warm
 * x-opencode-session code to the pool. A new session (or a reviving one)
 * whose prompt prefix overlaps enough with the old conversation takes the
 * warm code and hands its own fresh code back, so the new request reuses the
 * upstream prefix cache instead of paying a cold prefill.
 *
 * The pool is split in two tiers by how long the code has been inactive. Tier
 * 1 (default < 1h) is tried first and ranked by prefix match. Only when tier 1
 * has no eligible code is tier 2 considered; tier 2 is ranked by measured
 * speed (TTFT and throughput). Codes inactive for more than poolExpireMs
 * (default 24h) leave both tiers.
 */

import { VERSION, digestMatchPct, newRoutingId, round1, summarizeSamples } from './core.js';

const DAY_MS = 86400000;

function finite(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function positive(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function percent(value) {
  return Math.max(0, Math.min(100, finite(value, 0)));
}

function ageOf(route, now) {
  const last = finite(route.lastActiveAt, 0)
    || finite(route.pooledAt, 0)
    || finite(route.rotatedAt, 0)
    || finite(route.generatedAt, 0);
  return last > 0 ? Math.max(0, Number(now) - last) : Number.MAX_SAFE_INTEGER;
}

function sampleSummary(route, size) {
  return summarizeSamples(Array.isArray(route.samples) ? route.samples : [], size);
}

/**
 * The exact request sample recorded as the first request of a route window.
 * The request ring is only a recent view; when the true first sample has been
 * evicted we return null and the caller skips the event instead of promoting
 * a later warm request to "first".
 */
function requestAtMarker(requests, sessionId, marker) {
  const target = Number(marker);
  if (!Number.isFinite(target)) return null;
  let best = null;
  for (const request of requests) {
    if (String(request.sessionId) !== String(sessionId)) continue;
    const requestAt = Number(request.at);
    if (!Number.isFinite(requestAt)) continue;
    if (Math.abs(requestAt - target) > 1000) continue;
    if (!best || requestAt < Number(best.at)) best = request;
  }
  return best;
}

function effectSample(kind, event, request) {
  const cacheRead = request.cacheReadTokens == null ? null : Math.max(0, Math.round(Number(request.cacheReadTokens)));
  const input = request.inputTokens == null ? null : Math.max(0, Math.round(Number(request.inputTokens)));
  return {
    kind,
    sessionId: String(event.sessionId),
    at: Number(event.at),
    firstRequestAt: Number(request.at),
    matchPct: event.matchPct == null ? null : round1(event.matchPct),
    firstHitPct: request.hitPct == null ? null : round1(request.hitPct),
    firstTtftMs: request.ttftMs == null ? null : round1(request.ttftMs),
    firstTps: request.tps == null ? null : round1(request.tps),
    firstInputTokens: input,
    firstCacheReadTokens: cacheRead,
  };
}

function averageEffect(samples, field) {
  let total = 0;
  let count = 0;
  for (const sample of samples) {
    const value = Number(sample[field]);
    if (!Number.isFinite(value)) continue;
    total += value;
    count += 1;
  }
  return count > 0 ? round1(total / count) : null;
}

function summarizeEffect(samples) {
  return {
    count: samples.length,
    measured: samples.filter((sample) => Number.isFinite(Number(sample.firstHitPct))).length,
    avgFirstHitPct: averageEffect(samples, 'firstHitPct'),
    avgMatchPct: averageEffect(samples, 'matchPct'),
    avgFirstTtftMs: averageEffect(samples, 'firstTtftMs'),
    avgFirstInputTokens: averageEffect(samples, 'firstInputTokens'),
    avgFirstCacheReadTokens: averageEffect(samples, 'firstCacheReadTokens'),
  };
}

function codeFields(route) {
  return {
    value: route.value,
    digest: Array.isArray(route.digest) ? route.digest.slice() : [],
    digestChars: finite(route.digestChars, 0),
    digestUpdatedAt: finite(route.digestUpdatedAt, 0),
    lastActiveAt: finite(route.lastActiveAt, 0),
    generatedAt: finite(route.generatedAt, 0),
    samples: Array.isArray(route.samples) ? route.samples.map((sample) => ({ ...sample })) : [],
  };
}

export class SessionPool {
  constructor(options) {
    const opts = options || {};
    this.store = opts.store;
    this.config = opts.config;
    this.activity = opts.activity || null;
    this.logger = opts.logger || console;
    this.now = typeof opts.now === 'function' ? opts.now : Date.now;
    this.getAgentStatus = typeof opts.getAgentStatus === 'function' ? opts.getAgentStatus : null;
    this.getArchivedSessionIds = typeof opts.getArchivedSessionIds === 'function' ? opts.getArchivedSessionIds : null;
    this.lastAdoption = null;
    this.lastRevival = null;
  }

  debug(line) {
    if (!this.config || this.config.debug !== true) return;
    try {
      const logger = this.logger;
      if (logger && typeof logger.info === 'function') logger.info('[opencode-router] ' + line);
    } catch {
      // Best effort.
    }
  }

  summaryFor(route, size = this.config.poolSampleSize) {
    return sampleSummary(route || {}, size);
  }

  /** Describe one pooled route for the status endpoint without exposing the digest. */
  describe(sessionId, route, now = this.now()) {
    const summary = this.summaryFor(route);
    const ageMs = ageOf(route, now);
    const tier = ageMs < this.config.poolTier1Ms ? 1 : 2;
    const eligible = Boolean(
      route
      && route.value
      && Array.isArray(route.digest)
      && route.digest.length > 0
      && summary.count >= this.config.poolSampleSize
      && averageTps(summary) > this.config.poolMinTps
      && averageTtft(summary) <= this.config.poolMaxTtftMs,
    );
    return {
      sessionId: String(sessionId),
      code: String(route.value || ''),
      pooledAt: finite(route.pooledAt, 0) || null,
      lastActiveAt: finite(route.lastActiveAt, 0) || null,
      ageMs,
      tier,
      eligible,
      digestChunks: Array.isArray(route.digest) ? route.digest.length : 0,
      digestChars: finite(route.digestChars, 0),
      samples: summary.count,
      avgTtftMs: summary.avgTtftMs == null ? null : round1(summary.avgTtftMs),
      avgTps: summary.avgTps == null ? null : round1(summary.avgTps),
      score: summary.avgTtftMs == null ? null : round1(scoreOf({
        avgTtftMs: summary.avgTtftMs,
        avgTps: summary.avgTps,
      })),
    };
  }

  stats() {
    const now = this.now();
    const entries = this.store.routes()
      .filter(({ route }) => route && route.pooledAt != null)
      .map(({ sessionId, route }) => this.describe(sessionId, route, now));
    let tier1 = 0;
    let tier2 = 0;
    let eligible = 0;
    for (const entry of entries) {
      if (entry.tier === 1) tier1 += 1;
      else tier2 += 1;
      if (entry.eligible) eligible += 1;
    }
    return {
      enabled: this.config.poolEnabled !== false,
      idleMs: this.config.poolIdleMs,
      matchPct: this.config.poolMatchPct,
      crossTierFallback: this.config.poolCrossTierFallback !== false,
      minTps: this.config.poolMinTps,
      maxTtftMs: this.config.poolMaxTtftMs,
      tier1Ms: this.config.poolTier1Ms,
      expireMs: this.config.poolExpireMs,
      maxEntries: this.config.poolMaxEntries,
      total: entries.length,
      tier1,
      tier2,
      eligible,
      lastAdoption: this.lastAdoption ? { ...this.lastAdoption } : null,
      lastRevival: this.lastRevival ? { ...this.lastRevival } : null,
      entries,
      effect: this.effect(),
    };
  }

  /**
   * First-request cache effect of pool adoption, for the settings page.
   *
   * The comparison is deliberately narrow: one adopted event is measured by
   * the first request sent on the borrowed code, and one fresh session by the
   * first request sent on its newly generated code. Later requests are warm on
   * both sides and would only dilute the signal. Samples outside the request
   * ring are skipped rather than approximated.
   */
  effect() {
    const requests = this.store.recentRequests(200);
    const history = this.store.history(100);
    const routes = this.store.routes();
    const poolEvents = this.store.poolEvents();

    const adoptedEvents = [];
    const seenAdoptions = new Set();
    const addAdoption = (sessionId, at, matchPct, firstRequestAt) => {
      const marker = firstRequestAt == null ? null : Number(firstRequestAt);
      const duplicate = adoptedEvents.find((event) => (
        String(event.sessionId) === String(sessionId)
        && Math.abs(Number(event.at) - Number(at)) < 1000
      ));
      if (duplicate) {
        if (duplicate.firstRequestAt == null && marker != null) duplicate.firstRequestAt = marker;
        if (duplicate.matchPct == null && matchPct != null) duplicate.matchPct = matchPct;
        return;
      }
      const key = String(sessionId) + '@' + String(at);
      if (seenAdoptions.has(key)) return;
      seenAdoptions.add(key);
      adoptedEvents.push({
        sessionId: String(sessionId),
        at: Number(at),
        matchPct,
        firstRequestAt: marker,
      });
    };
    for (const event of poolEvents) {
      if (event.role !== 'adopted') continue;
      addAdoption(event.sessionId, event.at, event.matchPct, event.firstRequest ? event.firstRequest.at : null);
    }
    for (const entry of history) {
      if (entry.poolRole === 'adopted' || entry.reason === 'pool-adopted') {
        addAdoption(entry.sessionId, entry.at, entry.poolMatchPct, entry.firstRequestAt);
      }
    }
    for (const { sessionId, route } of routes) {
      if (route.reason === 'pool-adopted' && route.rotatedAt != null) {
        addAdoption(sessionId, route.rotatedAt, null, route.firstRequestAt);
      }
    }
    const adoptedSessions = new Set(adoptedEvents.map((event) => event.sessionId));

    // A fresh baseline is a session that started on a pool-initial code and
    // never borrowed another code. Current routes are authoritative for recent
    // sessions because pool-initial is not written to history; history covers
    // sessions that have since donated their code and now show pool-donated.
    const baselineBySession = new Map();
    const addBaseline = (sessionId, at, firstRequestAt) => {
      const key = String(sessionId);
      if (adoptedSessions.has(key)) return;
      const marker = firstRequestAt == null ? null : Number(firstRequestAt);
      const current = baselineBySession.get(key);
      if (current == null || Number(at) < current.at) {
        baselineBySession.set(key, { at: Number(at), firstRequestAt: marker });
      } else if (Number(at) === current.at && current.firstRequestAt == null && marker != null) {
        current.firstRequestAt = marker;
      }
    };
    for (const entry of history) {
      if (entry.reason === 'pool-initial') addBaseline(entry.sessionId, entry.at, entry.firstRequestAt);
    }
    for (const { sessionId, route } of routes) {
      if (route.reason === 'pool-initial' && route.rotatedAt != null) {
        addBaseline(sessionId, route.rotatedAt, route.firstRequestAt);
      }
    }

    // The first request may already have left the 200-entry request ring.
    // The adoption event keeps a snapshot, so use it instead of skipping the
    // event; events recorded before snapshots existed still fall back to null.
    const snapshotFor = (sessionId, at) => {
      const event = poolEvents.find((item) => (
        item.role === 'adopted'
        && String(item.sessionId) === String(sessionId)
        && Math.abs(Number(item.at) - Number(at)) < 1000
        && item.firstRequest
      ));
      return event ? event.firstRequest : null;
    };
    const adopted = [];
    for (const event of adoptedEvents) {
      const request = requestAtMarker(requests, event.sessionId, event.firstRequestAt)
        || snapshotFor(event.sessionId, event.at);
      if (request) adopted.push(effectSample('adopted', event, request));
    }
    const baseline = [];
    for (const [sessionId, event] of baselineBySession) {
      const request = requestAtMarker(requests, sessionId, event.firstRequestAt);
      if (request) baseline.push(effectSample('baseline', { ...event, sessionId }, request));
    }
    const adoptedSummary = summarizeEffect(adopted);
    const baselineSummary = summarizeEffect(baseline);
    const deltaPct = adoptedSummary.avgFirstHitPct != null && baselineSummary.avgFirstHitPct != null
      ? round1(adoptedSummary.avgFirstHitPct - baselineSummary.avgFirstHitPct)
      : null;
    const samples = adopted.concat(baseline)
      .sort((a, b) => Number(b.firstRequestAt) - Number(a.firstRequestAt))
      .slice(0, 8);
    return {
      adopted: adoptedSummary,
      baseline: baselineSummary,
      deltaPct,
      samples,
    };
  }

  /**
   * Ensure the session has a routing id and, when it is new or reviving, try
   * to take a warm one from the pool. Called before the cache prediction so
   * the adopted code is used by the request that triggered it.
   */
  prepareRoute(input) {
    const opts = input || {};
    const sessionId = String(opts.sessionId == null ? '' : opts.sessionId);
    if (sessionId === '') return { action: 'none', route: null, skipPrediction: false };
    if (this.config.poolEnabled === false) {
      return { action: 'disabled', route: this.store.routeFor(sessionId), skipPrediction: false };
    }
    const digest = normalizeDigest(opts.digest);
    const now = finite(opts.now, this.now());
    let route = this.store.routeFor(sessionId);
    if (!route) {
      const created = {
        value: newRoutingId(this.config.routingIdPrefix),
        rotatedAt: now,
        reason: 'pool-initial',
        basis: 'pool-initial',
        generatedAt: now,
        lastActiveAt: now,
        digest: digest.chunks,
        digestChars: digest.chars,
        digestUpdatedAt: now,
        samples: [],
        firstRequestAt: null,
        awaitingFirstRequest: true,
      };
      this.store.setRoute(sessionId, created);
      const acquired = this.acquire({ sessionId, route: created, digest, now });
      return { ...acquired, skipPrediction: acquired.action === 'adopted' };
    }

    // Only a code that is actually in the pool (or a donor that gave its code
    // away) triggers an acquisition. A merely idle session stays active until
    // the periodic scan puts its code into the pool; that avoids treating a
    // normal pause in a still-warm conversation as a revival.
    const pooled = route.pooledAt != null;
    const sleeping = route.sleepingAt != null;
    // A code that stayed unused past the expiration window is no longer in
    // either tier, but it was never reassigned. Revival still returns it to
    // its owner; a different session cannot adopt it.
    const expired = ageOf(route, now) > this.config.poolExpireMs;
    if (pooled || sleeping || expired) {
      const acquired = this.acquire({ sessionId, route, digest, now, revival: true, expired });
      return {
        ...acquired,
        skipPrediction: acquired.action === 'adopted' || acquired.action === 'revived',
      };
    }

    const next = {
      ...route,
      lastActiveAt: now,
      digest: digest.chunks,
      digestChars: digest.chars,
      digestUpdatedAt: now,
      pooledAt: null,
      sleepingAt: null,
      poolEvictedAt: null,
    };
    this.store.setRoute(sessionId, next);
    return { action: 'active', route: this.store.routeFor(sessionId), skipPrediction: false };
  }

  /**
   * Pick and exchange a pooled code. The current session hands its current
   * code to the donor session (so the donor is not left without a code) and
   * receives the donor's warm code in return.
   */
  acquire(input) {
    const opts = input || {};
    const sessionId = String(opts.sessionId == null ? '' : opts.sessionId);
    const digest = normalizeDigest(opts.digest);
    const now = finite(opts.now, this.now());
    const current = this.store.routeFor(sessionId) || opts.route;
    if (!current) return { action: 'none', route: null, skipPrediction: false };
    const revival = opts.revival === true;

    // Revival is not an adoption. A returning session gets its own routing id
    // back whenever that id is still idle; it never competes for a tier-1 or
    // tier-2 candidate, and no match, sample, or speed test applies. If the id
    // was already handed to another session, the fresh replacement installed
    // by that donation is kept instead of borrowing yet another code.
    if (revival) {
      const ownCode = String(current.value || '');
      const handedAway = current.sleepingAt != null;
      if (!handedAway && ownCode !== '') {
        const revived = {
          ...current,
          pooledAt: null,
          sleepingAt: null,
          poolEvictedAt: null,
          lastActiveAt: now,
          digest: digest.chunks,
          digestChars: digest.chars,
          digestUpdatedAt: now,
        };
        this.store.setRoute(sessionId, revived);
        this.lastRevival = { at: now, sessionId, matchPct: null, tier: null };
        this.recordPoolEvent({
          at: now,
          role: 'revived',
          sessionId,
          sourceSessionId: sessionId,
          code: revived.value,
          matchPct: null,
          tier: null,
        });
        this.debug('revived own idle code for ' + sessionId);
        return {
          action: 'revived',
          route: this.store.routeFor(sessionId),
          matchPct: null,
          tier: null,
        };
      }
      const kept = {
        ...current,
        value: ownCode !== '' ? ownCode : newRoutingId(this.config.routingIdPrefix),
        pooledAt: null,
        sleepingAt: null,
        poolEvictedAt: null,
        lastActiveAt: now,
        digest: digest.chunks,
        digestChars: digest.chars,
        digestUpdatedAt: now,
        generatedAt: ownCode !== '' ? finite(current.generatedAt, 0) || now : now,
        rotatedAt: ownCode !== '' ? finite(current.rotatedAt, 0) || now : now,
        samples: ownCode !== '' ? (Array.isArray(current.samples) ? current.samples : []) : [],
        firstRequestAt: ownCode !== '' ? finite(current.firstRequestAt, null) : null,
        awaitingFirstRequest: ownCode === '' || current.firstRequestAt == null,
      };
      this.store.setRoute(sessionId, kept);
      this.debug('revival kept fresh code for ' + sessionId);
      return { action: 'kept', route: this.store.routeFor(sessionId), skipPrediction: false };
    }

    // A session whose own code is still in the pool may only reclaim its own
    // code: taking another code would orphan the pooled one. If its own code
    // does not meet the bar, a reviving session falls back to a fresh code
    // (the pool's contract) while a direct caller keeps its code.
    const selfPooled = current.pooledAt != null && current.sleepingAt == null;
    const candidate = this.selectCandidate({
      sessionId,
      digest,
      now,
      selfOnly: selfPooled,
    });
    if (!candidate) {
      // No eligible donor. The session keeps or regenerates its code, but it
      // still has to refresh the activity stamp and digest: otherwise every
      // following request would look like another revival and re-scan the pool.
      const fallback = revival && (selfPooled || opts.expired === true);
      // The fallback below replaces the code, so the session-keyed
      // measurement window must not carry the retired code's samples into the
      // new code's prediction.
      if (fallback) this.clearMetrics(sessionId);
      const kept = {
        ...current,
        // The user-visible contract: when no pooled code qualifies, fall back
        // to generating a fresh one instead of reusing a code that did not
        // meet the pool bar. A sleeping donor already has a freshly generated
        // code, so it can keep that one.
        value: fallback ? newRoutingId(this.config.routingIdPrefix) : current.value,
        pooledAt: null,
        sleepingAt: null,
        poolEvictedAt: null,
        lastActiveAt: now,
        generatedAt: fallback ? now : finite(current.generatedAt, 0) || now,
        rotatedAt: fallback ? now : finite(current.rotatedAt, 0) || now,
        digest: digest.chunks,
        digestChars: digest.chars,
        digestUpdatedAt: now,
        samples: fallback ? [] : (Array.isArray(current.samples) ? current.samples : []),
        reason: fallback ? 'pool-fallback' : current.reason,
        basis: fallback ? 'pool-no-candidate' : current.basis,
        avgTtftMs: fallback ? null : current.avgTtftMs,
        avgTps: fallback ? null : current.avgTps,
        firstRequestAt: fallback ? null : finite(current.firstRequestAt, null),
        awaitingFirstRequest: fallback ? true : current.awaitingFirstRequest === true,
      };
      this.store.setRoute(sessionId, kept);
      return { action: 'kept', route: this.store.routeFor(sessionId), skipPrediction: false };
    }

    if (candidate.sessionId === sessionId) {
      const revived = {
        ...current,
        pooledAt: null,
        sleepingAt: null,
        poolEvictedAt: null,
        lastActiveAt: now,
        digest: digest.chunks,
        digestChars: digest.chars,
        digestUpdatedAt: now,
      };
      this.store.setRoute(sessionId, revived);
      this.lastRevival = {
        at: now,
        sessionId,
        matchPct: round1(candidate.matchPct),
        tier: candidate.tier,
      };
      this.recordPoolEvent({
        at: now,
        role: 'revived',
        sessionId,
        sourceSessionId: sessionId,
        code: revived.value,
        matchPct: round1(candidate.matchPct),
        tier: candidate.tier,
      });
      this.debug('revived own pooled code for ' + sessionId);
      return {
        action: 'revived',
        route: this.store.routeFor(sessionId),
        matchPct: round1(candidate.matchPct),
        tier: candidate.tier,
      };
    }

    const donor = this.store.routeFor(candidate.sessionId) || candidate.route;
    if (!donor || donor.value !== candidate.route.value) {
      return { action: 'none', route: current, skipPrediction: false };
    }
    const adoptedFields = codeFields(donor);
    const currentExpired = ageOf(current, now) > this.config.poolExpireMs;
    const handedFields = {
      ...codeFields(current),
      // The donor receives a code from the other session. A code that stayed
      // inactive beyond the pool expiration must never travel; generate a
      // fresh replacement instead so it cannot come back as a cold handoff.
      value: currentExpired ? newRoutingId(this.config.routingIdPrefix) : current.value,
      // The donor receives a fresh-by-generation code. It has no digest or
      // samples attached until the donor itself sends a request.
      digest: [],
      digestChars: 0,
      digestUpdatedAt: now,
      samples: [],
      lastActiveAt: now,
      generatedAt: now,
    };
    const next = {
      ...current,
      value: adoptedFields.value,
      digest: adoptedFields.digest,
      digestChars: adoptedFields.digestChars,
      digestUpdatedAt: adoptedFields.digestUpdatedAt,
      lastActiveAt: now,
      generatedAt: adoptedFields.generatedAt,
      samples: adoptedFields.samples,
      pooledAt: null,
      sleepingAt: null,
      poolEvictedAt: null,
      adoptedFrom: donorSessionId(candidate),
      rotatedAt: now,
      reason: 'pool-adopted',
      basis: 'pool-match',
      cacheHitPct: null,
      step: 0,
      avgTtftMs: candidate.summary.avgTtftMs == null ? null : round1(candidate.summary.avgTtftMs),
      avgTps: candidate.summary.avgTps == null ? null : round1(candidate.summary.avgTps),
      firstRequestAt: null,
      awaitingFirstRequest: true,
    };
    const sleepingDonor = {
      ...donor,
      value: handedFields.value,
      digest: [],
      digestChars: 0,
      digestUpdatedAt: now,
      lastActiveAt: now,
      generatedAt: now,
      samples: [],
      pooledAt: null,
      sleepingAt: now,
      poolEvictedAt: null,
      adoptedFrom: sessionId,
      rotatedAt: now,
      reason: 'pool-donated',
      basis: 'pool-donated',
      cacheHitPct: null,
      step: 0,
      avgTtftMs: null,
      avgTps: null,
      firstRequestAt: null,
      awaitingFirstRequest: true,
    };
    this.store.setRoute(sessionId, next);
    this.store.setRoute(candidate.sessionId, sleepingDonor);
    // The measurement window is keyed by session, so it belonged to the code
    // each session just gave away. Start both windows fresh; the adopted code
    // still carries its code-bound samples on the route for pool scoring.
    this.clearMetrics(sessionId);
    this.clearMetrics(candidate.sessionId);
    this.recordAdoptionHistory({
      sessionId,
      now,
      adopted: adoptedFields,
      candidate,
      matchPct: candidate.matchPct,
      tier: candidate.tier,
      score: candidate.score,
    });
    this.recordDonationHistory({
      sessionId: candidate.sessionId,
      now,
      value: handedFields.value,
      sourceSessionId: sessionId,
      candidate,
    });
    this.lastAdoption = {
      at: now,
      sessionId,
      sourceSessionId: donorSessionId(candidate),
      matchPct: round1(candidate.matchPct),
      tier: candidate.tier,
      score: round1(candidate.score),
    };
    this.recordPoolEvent({
      at: now,
      role: 'adopted',
      sessionId,
      sourceSessionId: donorSessionId(candidate),
      code: adoptedFields.value,
      donorCode: handedFields.value,
      matchPct: round1(candidate.matchPct),
      tier: candidate.tier,
      score: round1(candidate.score),
      donorTtftMs: candidate.summary.avgTtftMs == null ? null : round1(candidate.summary.avgTtftMs),
      donorTps: candidate.summary.avgTps == null ? null : round1(candidate.summary.avgTps),
      donorSamples: candidate.summary.count,
    });
    this.debug('adopted pooled code for ' + sessionId + ' from ' + donorSessionId(candidate));
    return {
      action: 'adopted',
      route: this.store.routeFor(sessionId),
      matchPct: round1(candidate.matchPct),
      tier: candidate.tier,
      score: round1(candidate.score),
      sourceSessionId: donorSessionId(candidate),
    };
  }

  selectCandidate(input) {
    const opts = input || {};
    const sessionId = String(opts.sessionId == null ? '' : opts.sessionId);
    const digest = normalizeDigest(opts.digest);
    const now = finite(opts.now, this.now());
    const tier1 = [];
    const tier2 = [];
    for (const { sessionId: ownerId, route } of this.store.routes()) {
      if (route.pooledAt == null) continue;
      if (opts.selfOnly === true && ownerId !== sessionId) continue;
      if (ownerId === sessionId && route.sleepingAt != null) continue;
      if (!route.value || !Array.isArray(route.digest) || route.digest.length === 0) continue;
      const summary = this.summaryFor(route);
      if (summary.count < this.config.poolSampleSize) continue;
      if (averageTtft(summary) > this.config.poolMaxTtftMs) continue;
      if (!(averageTps(summary) > this.config.poolMinTps)) continue;
      const ageMs = ageOf(route, now);
      if (ageMs > this.config.poolExpireMs) continue;
      const tier = ageMs < this.config.poolTier1Ms ? 1 : 2;
      const matchPct = digestMatchPct(route.digest, digest.chunks);
      const entry = {
        sessionId: ownerId,
        route,
        summary,
        matchPct,
        tier,
        matchOk: tier === 1 ? matchPct >= this.config.poolMatchPct : true,
        score: scoreOf(summary),
        ageMs,
      };
      if (tier === 1) tier1.push(entry);
      else tier2.push(entry);
    }
    const qualified = tier1.filter((entry) => entry.matchOk);
    if (qualified.length > 0) {
      qualified.sort((a, b) => {
        if (b.matchPct !== a.matchPct) return b.matchPct - a.matchPct;
        if (b.summary.avgTps !== a.summary.avgTps) return b.summary.avgTps - a.summary.avgTps;
        if (a.summary.avgTtftMs !== b.summary.avgTtftMs) return a.summary.avgTtftMs - b.summary.avgTtftMs;
        return finite(b.route.lastActiveAt) - finite(a.route.lastActiveAt);
      });
      return qualified[0];
    }
    // No tier-1 code covers enough of the new prefix. Normally tier 2 is the
    // speed tier and is considered alone. With the cross-tier fallback on,
    // tier-1 codes that missed the prefix floor join tier 2 in one score
    // ranking, so the fastest eligible code wins instead of the fastest
    // tier-2 code.
    if (this.config.poolCrossTierFallback !== false && tier2.length > 0) {
      const combined = tier1.concat(tier2);
      combined.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (b.matchPct !== a.matchPct) return b.matchPct - a.matchPct;
        return b.summary.avgTps - a.summary.avgTps;
      });
      return combined[0];
    }
    if (tier2.length > 0) {
      tier2.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (b.matchPct !== a.matchPct) return b.matchPct - a.matchPct;
        return b.summary.avgTps - a.summary.avgTps;
      });
      return tier2[0];
    }
    return null;
  }

  clearMetrics(sessionId) {
    try {
      if (this.store && typeof this.store.clearSamples === 'function') {
        this.store.clearSamples(sessionId);
      }
    } catch {
      // Sample cleanup is best effort; never block the swap.
    }
  }

  recordAdoptionHistory(input) {
    const opts = input || {};
    const candidate = opts.candidate;
    try {
      this.store.addRotation({
        id: String(opts.sessionId) + '@' + String(opts.now),
        sessionId: opts.sessionId,
        at: opts.now,
        value: opts.adopted.value,
        reason: 'pool-adopted',
        basis: 'pool-match',
        step: 0,
        beforeTtftMs: candidate.summary.avgTtftMs == null ? null : round1(candidate.summary.avgTtftMs),
        beforeTps: candidate.summary.avgTps == null ? null : round1(candidate.summary.avgTps),
        beforeSamples: candidate.summary.count,
        afterTarget: this.config.sampleSize,
        version: VERSION,
        thresholds: null,
        poolMatchPct: round1(opts.matchPct),
        poolTier: opts.tier,
        poolScore: round1(opts.score),
        poolSourceSessionId: donorSessionId(candidate),
        poolRole: 'adopted',
      });
    } catch (error) {
      this.debug('adoption history failed: ' + String(error && error.message ? error.message : error));
    }
  }

  recordDonationHistory(input) {
    const opts = input || {};
    try {
      this.store.addRotation({
        id: String(opts.sessionId) + '@' + String(opts.now),
        sessionId: opts.sessionId,
        at: opts.now,
        value: opts.value,
        reason: 'pool-donated',
        basis: 'pool-donated',
        step: 0,
        afterTarget: this.config.sampleSize,
        version: VERSION,
        thresholds: null,
        poolSourceSessionId: opts.sourceSessionId,
        poolRole: 'donated',
      });
    } catch (error) {
      this.debug('donation history failed: ' + String(error && error.message ? error.message : error));
    }
  }

  recordPoolEvent(input) {
    const opts = input || {};
    try {
      this.store.addPoolEvent(opts);
    } catch (error) {
      this.debug('pool event failed: ' + String(error && error.message ? error.message : error));
    }
  }

  /** Put one session's current code into the pool. */
  poolSession(sessionId, reason = 'idle', now = this.now()) {
    const key = String(sessionId == null ? '' : sessionId);
    if (key === '') return false;
    const route = this.store.routeFor(key);
    if (!route || route.pooledAt != null) return false;
    // A sleeping donor already has a fresh code; it becomes poolable only
    // after the donor sends a request and goes idle again.
    if (route.sleepingAt != null) return false;
    // A code evicted by the size cap stays out until the session becomes
    // active again; otherwise a full pool would re-pool it on every tick.
    if (route.poolEvictedAt != null) return false;
    // Codes past the expiration window are out of both tiers for good. Without
    // this guard an idle session would re-pool its expired code on every tick.
    if (ageOf(route, now) > this.config.poolExpireMs) return false;
    // A route created before 0.6.0 has no prefix digest yet. Such a code can
    // never match another session, so pooling it would only make its owner
    // fall back to a fresh code on revival. Leave it active until the owner
    // sends a request and the digest exists.
    if (!Array.isArray(route.digest) || route.digest.length === 0) return false;
    // A code with fewer than poolSampleSize samples can never be selected: the
    // matcher needs that many samples to judge TTFT and throughput. Pooling it
    // would only make its owner fall back to a fresh code on revival, so keep
    // it active until it has enough evidence to be reusable.
    const summary = this.summaryFor(route);
    if (summary.count < this.config.poolSampleSize) return false;
    // 0.6.1: only codes that proved fast are worth lending. A slow code would
    // hand its latency to the adopter, so it stays active on its owner.
    if (!(averageTps(summary) > this.config.poolMinTps)) return false;
    if (averageTtft(summary) > this.config.poolMaxTtftMs) return false;
    const next = {
      ...route,
      pooledAt: now,
      lastActiveAt: finite(route.lastActiveAt, 0) || now,
    };
    this.store.setRoute(key, next);
    this.debug('pooled ' + key + ' (' + reason + ')');
    return true;
  }

  /**
   * Remove a pooled code from the pool without touching the rest of the
   * session route. The eviction stamp keeps the idle scan from putting the
   * same code straight back when the pool is at its size limit.
   */
  unpoolSession(sessionId, now = this.now()) {
    const key = String(sessionId == null ? '' : sessionId);
    if (key === '') return false;
    const route = this.store.routeFor(key);
    if (!route || route.pooledAt == null) return false;
    this.store.setRoute(key, { ...route, pooledAt: null, poolEvictedAt: now });
    this.debug('unpooled code for ' + key);
    return true;
  }

  /** Clear codes that have been inactive for longer than poolExpireMs. */
  expire(now = this.now()) {
    let changed = 0;
    for (const { sessionId, route } of this.store.routes()) {
      if (route.pooledAt == null) continue;
      if (ageOf(route, now) <= this.config.poolExpireMs) continue;
      if (this.unpoolSession(sessionId, now)) changed += 1;
    }
    return changed;
  }

  /** Enforce the pool size limit; the oldest inactive code leaves first. */
  trim(now = this.now()) {
    const pooled = this.store.routes()
      .filter(({ route }) => route.pooledAt != null)
      .sort((a, b) => ageOf(b.route, now) - ageOf(a.route, now));
    let removed = 0;
    while (pooled.length > this.config.poolMaxEntries) {
      const oldest = pooled.shift();
      if (oldest && this.unpoolSession(oldest.sessionId, now)) removed += 1;
    }
    return removed;
  }

  /**
   * Periodic scan: archive means the session is definitively over; otherwise
   * require the agent to be idle, no turn/tool/approval/job pending, and the
   * configured idle gap to have elapsed.
   */
  tick(now = this.now()) {
    this.expire(now);
    const archived = this.archivedSet();
    let pooled = 0;
    for (const { sessionId, route } of this.store.routes()) {
      if (!route || !route.value || route.pooledAt != null || route.sleepingAt != null) continue;
      if (archived.has(sessionId)) {
        if (this.poolSession(sessionId, 'archived', now)) pooled += 1;
        continue;
      }
      if (!this.activity) continue;
      const activityLast = this.activity.lastActivityAt(sessionId);
      const routeLast = Math.max(
        finite(route.lastActiveAt, 0),
        finite(route.rotatedAt, 0),
        finite(route.generatedAt, 0),
      );
      const last = Math.max(activityLast, routeLast);
      if (last <= 0) continue;
      if (now - last < this.config.poolIdleMs) continue;
      if (this.activity.isBusy(sessionId)) continue;
      if (this.agentStatus(sessionId) === 'running') continue;
      if (this.poolSession(sessionId, 'idle', now)) pooled += 1;
    }
    this.trim(now);
    if (this.activity && typeof this.activity.prune === 'function') this.activity.prune(now);
    return pooled;
  }

  archivedSet() {
    if (!this.getArchivedSessionIds) return new Set();
    try {
      const ids = this.getArchivedSessionIds();
      return new Set(Array.isArray(ids) ? ids.map((id) => String(id)) : []);
    } catch {
      return new Set();
    }
  }

  agentStatus(sessionId) {
    if (!this.getAgentStatus) return '';
    try {
      return String(this.getAgentStatus(sessionId) || '');
    } catch {
      return '';
    }
  }
}

function normalizeDigest(digest) {
  const value = digest || {};
  const chunks = Array.isArray(value.chunks)
    ? value.chunks.filter((chunk) => typeof chunk === 'string' && chunk.length > 0)
    : [];
  return { chunks, chars: Math.max(0, finite(value.chars, 0)) };
}

function averageTtft(summary) {
  return summary && Number.isFinite(Number(summary.avgTtftMs)) ? Number(summary.avgTtftMs) : Number.POSITIVE_INFINITY;
}

function averageTps(summary) {
  return summary && Number.isFinite(Number(summary.avgTps)) ? Number(summary.avgTps) : 0;
}

function scoreOf(summary) {
  return -(averageTtft(summary) / 1000) * 10 + averageTps(summary);
}

function donorSessionId(candidate) {
  return candidate && candidate.sessionId != null ? String(candidate.sessionId) : '';
}
