/**
 * ============================================================================
 * NYC FloodGuard — Phase 2: Official NYC Open Data (FloodNet) API Integration
 * File: nycOpenData.js
 *
 * Public Socrata Open Data API (SODA) Endpoints (No API keys or paid tier):
 *   1. Flood Events (Historical Archive):
 *      https://data.cityofnewyork.us/resource/aq7i-eu5q.json
 *   2. Sensor Deployment Metadata:
 *      https://data.cityofnewyork.us/resource/kb2e-tjy3.json
 *   3. Dataset Catalog Metadata (for most recent API dataset update timestamp):
 *      https://data.cityofnewyork.us/api/views/aq7i-eu5q.json
 *
 * Strict Data Separation:
 *   All data retrieved here is REAL HISTORICAL ARCHIVE DATA (NOT LIVE) from
 *   NYC FloodNet and is kept completely separate from local 5-second simulated
 *   telemetry and Supabase sensor/water_reading demo tables.
 * ============================================================================
 */

export const NYC_OPEN_DATA_ENDPOINTS = {
  FLOOD_EVENTS: 'https://data.cityofnewyork.us/resource/aq7i-eu5q.json',
  SENSOR_METADATA: 'https://data.cityofnewyork.us/resource/kb2e-tjy3.json',
  FLOOD_EVENTS_VIEW_META: 'https://data.cityofnewyork.us/api/views/aq7i-eu5q.json'
};

const EVENT_SELECT_FIELDS = [
  'sensor_name',
  'sensor_id',
  'flood_start_time',
  'flood_end_time',
  'max_depth_inches',
  'duration_mins',
  'onset_time_mins',
  'drain_time_mins'
].join(',');

function escapeSoqlString(value) {
  return String(value ?? '').replace(/'/g, "''");
}

function escapeSoqlLikeLiteral(value) {
  return escapeSoqlString(value).replace(/%/g, '\\%').replace(/_/g, '\\_');
}

function sensorMatchesSearchTerm(sensor, lowerTerm) {
  if (!lowerTerm) return true;
  const haystacks = [
    sensor.sensorName,
    sensor.streetName,
    sensor.borough,
    sensor.zipcode,
    sensor.nta,
    sensor.sensorId
  ];
  return haystacks.some((val) => String(val || '').toLowerCase().includes(lowerTerm));
}

function normalizeSensorMetadataRow(raw) {
  const lat = raw.latitude != null ? Number(raw.latitude) : null;
  const lng = raw.longitude != null ? Number(raw.longitude) : null;
  return {
    sensorId: raw.sensor_id || '',
    sensorName: raw.sensor_name || raw.sensor_id || 'Unknown Sensor',
    streetName: raw.street_name || '',
    borough: raw.borough || '',
    zipcode: raw.zipcode || '',
    nta: raw.nta || '',
    dateInstalled: raw.date_installed || '',
    tidallyInfluenced: String(raw.tidally_influenced || ''),
    communityBoard: raw.community_board || '',
    councilDistrict: raw.council_district || '',
    latitude: Number.isFinite(lat) ? lat : null,
    longitude: Number.isFinite(lng) ? lng : null
  };
}

/**
 * Retrieves the FloodNet sensor deployment directory (~496 sensors) from
 * `kb2e-tjy3.json`, plus the dataset's most recent API update date and latest
 * recorded historical event timestamp.
 */
export async function fetchFloodNetSensorMetadata(options = {}) {
  const { signal } = options;
  const metaParams = new URLSearchParams({
    $limit: '1000',
    $order: 'sensor_name ASC'
  });

  const metaUrl = `${NYC_OPEN_DATA_ENDPOINTS.SENSOR_METADATA}?${metaParams.toString()}`;
  const latestEventUrl = `${NYC_OPEN_DATA_ENDPOINTS.FLOOD_EVENTS}?${new URLSearchParams({
    $select: 'max(flood_start_time) as latest_event_time'
  }).toString()}`;

  const startedAt = performance.now();

  const [metaResponse, viewMetaResponse, latestEventResponse] = await Promise.all([
    fetch(metaUrl, { method: 'GET', headers: { Accept: 'application/json' }, signal }),
    fetch(NYC_OPEN_DATA_ENDPOINTS.FLOOD_EVENTS_VIEW_META, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal
    }).catch(() => null),
    fetch(latestEventUrl, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal
    }).catch(() => null)
  ]);

  if (!metaResponse.ok) {
    throw new Error(
      `Sensor metadata API returned HTTP ${metaResponse.status} (${metaResponse.statusText || 'Request failed'}).`
    );
  }

  const rawRows = await metaResponse.json();
  if (!Array.isArray(rawRows)) {
    throw new Error('Unexpected JSON structure from NYC Open Data sensor metadata endpoint.');
  }

  let apiUpdatedAtIso = '';
  if (viewMetaResponse && viewMetaResponse.ok) {
    try {
      const viewMeta = await viewMetaResponse.json();
      const epochSec = viewMeta?.rowsUpdatedAt || viewMeta?.viewLastModified || null;
      if (epochSec && Number.isFinite(Number(epochSec))) {
        apiUpdatedAtIso = new Date(Number(epochSec) * 1000).toISOString();
      }
    } catch {
      // Optional catalog metadata fallback handled below
    }
  }

  let latestRecordedEventIso = '';
  if (latestEventResponse && latestEventResponse.ok) {
    try {
      const latestRows = await latestEventResponse.json();
      if (Array.isArray(latestRows) && latestRows[0]?.latest_event_time) {
        latestRecordedEventIso = latestRows[0].latest_event_time;
      }
    } catch {
      // Non-fatal
    }
  }

  const sensorsList = rawRows.map(normalizeSensorMetadataRow).filter((s) => s.sensorId);
  const sensorById = new Map();
  const boroughSet = new Set();

  sensorsList.forEach((sensor) => {
    sensorById.set(sensor.sensorId, sensor);
    if (sensor.borough) boroughSet.add(sensor.borough);
  });

  const boroughs = Array.from(boroughSet).sort((a, b) => a.localeCompare(b));
  const latencyMs = Math.round(performance.now() - startedAt);

  return {
    sensorsList,
    sensorById,
    boroughs,
    apiUpdatedAtIso,
    latestRecordedEventIso,
    latencyMs,
    fetchedAtMs: Date.now()
  };
}

/**
 * Queries real historical NYC FloodNet events from `aq7i-eu5q.json`, applies
 * exact combined filtering (case-insensitive search across sensor names +
 * street/borough/ZIP/location metadata intersected with selected borough,
 * specific sensor, and date range), computes total matching filtered rows via
 * `$select=count(*)`, and paginates strictly across the filtered results
 * (supporting >1,000 records).
 */
export async function fetchFloodNetEvents({
  search = '',
  sensorId = 'ALL',
  borough = 'ALL',
  startDate = '',
  endDate = '',
  page = 1,
  pageSize = 25,
  sensorsList = [],
  sensorById = new Map(),
  signal
} = {}) {
  const cleanSearch = String(search || '').trim();
  const lowerTerm = cleanSearch.toLowerCase();
  const safePageSize = Math.max(10, Math.min(100, Number(pageSize) || 25));
  const requestedPage = Math.max(1, Number(page) || 1);

  const emptyResult = {
    records: [],
    totalCount: 0,
    page: 1,
    pageSize: safePageSize,
    totalPages: 1,
    offset: 0,
    latencyMs: 0,
    fetchedAtMs: Date.now(),
    requestUrl: ''
  };

  const whereClauses = [];

  // 1. Specific sensor filter
  if (sensorId && sensorId !== 'ALL') {
    const selectedMeta = sensorById.get(sensorId) || null;
    if (borough && borough !== 'ALL' && selectedMeta && selectedMeta.borough !== borough) {
      return emptyResult;
    }
    if (cleanSearch && selectedMeta && !sensorMatchesSearchTerm(selectedMeta, lowerTerm)) {
      return emptyResult;
    }
    whereClauses.push(`sensor_id = '${escapeSoqlString(sensorId)}'`);
  }

  // 2. Combined Borough + Case-Insensitive Search over joined sensor metadata
  if (borough && borough !== 'ALL') {
    const boroughSensors = sensorsList.filter((s) => s.borough === borough);
    const matchingSensors = cleanSearch
      ? boroughSensors.filter((s) => sensorMatchesSearchTerm(s, lowerTerm))
      : boroughSensors;

    if (matchingSensors.length === 0) {
      return emptyResult;
    }

    const idList = matchingSensors.map((s) => `'${escapeSoqlString(s.sensorId)}'`).join(',');
    whereClauses.push(`sensor_id in (${idList})`);
  } else if (cleanSearch) {
    // All boroughs selected + search string
    const matchedSensors = sensorsList.filter((s) => sensorMatchesSearchTerm(s, lowerTerm));
    const upperEscaped = escapeSoqlLikeLiteral(cleanSearch.toUpperCase());
    const directTextClause = `(upper(sensor_name) like '%${upperEscaped}%' OR upper(sensor_id) like '%${upperEscaped}%')`;

    if (matchedSensors.length === 0) {
      // Still query SODA text fields in case an event row is not yet in kb2e-tjy3
      whereClauses.push(directTextClause);
    } else if (matchedSensors.length <= 240) {
      const idList = matchedSensors.map((s) => `'${escapeSoqlString(s.sensorId)}'`).join(',');
      whereClauses.push(`(${directTextClause} OR sensor_id in (${idList}))`);
    } else {
      // Complement optimization: when >240 sensors match (e.g., "Ave" or "St"),
      // excluding the smaller unmatched set keeps the GET URL compact while
      // preserving exact street_name / location metadata matching.
      const matchedSet = new Set(matchedSensors.map((s) => s.sensorId));
      const unmatchedIds = sensorsList
        .filter((s) => !matchedSet.has(s.sensorId))
        .map((s) => `'${escapeSoqlString(s.sensorId)}'`);

      if (unmatchedIds.length === 0) {
        // Every known sensor matched
      } else if (unmatchedIds.length <= 240) {
        whereClauses.push(`(${directTextClause} OR sensor_id not in (${unmatchedIds.join(',')}))`);
      } else {
        whereClauses.push(directTextClause);
      }
    }
  }

  // 3. Date range filters on flood_start_time
  if (startDate) {
    whereClauses.push(`flood_start_time >= '${escapeSoqlString(startDate)}T00:00:00.000'`);
  }
  if (endDate) {
    whereClauses.push(`flood_start_time <= '${escapeSoqlString(endDate)}T23:59:59.999'`);
  }

  const sharedParams = {};
  if (whereClauses.length > 0) {
    sharedParams.$where = whereClauses.join(' AND ');
  }

  const startedAt = performance.now();

  // Compute filtered total count first/in-parallel so pagination always stays within filtered bounds
  const countParams = new URLSearchParams({
    ...sharedParams,
    $select: 'count(*) as total_count'
  });
  const countUrl = `${NYC_OPEN_DATA_ENDPOINTS.FLOOD_EVENTS}?${countParams.toString()}`;

  const offset = (requestedPage - 1) * safePageSize;
  const rowsParams = new URLSearchParams({
    ...sharedParams,
    $select: EVENT_SELECT_FIELDS,
    $order: 'flood_start_time DESC',
    $limit: String(safePageSize),
    $offset: String(offset)
  });
  const rowsUrl = `${NYC_OPEN_DATA_ENDPOINTS.FLOOD_EVENTS}?${rowsParams.toString()}`;

  const [rowsResponse, countResponse] = await Promise.all([
    fetch(rowsUrl, { method: 'GET', headers: { Accept: 'application/json' }, signal }),
    fetch(countUrl, { method: 'GET', headers: { Accept: 'application/json' }, signal })
  ]);

  if (!rowsResponse.ok) {
    const errText = await rowsResponse.text().catch(() => '');
    throw new Error(
      `NYC Flood Events API error (HTTP ${rowsResponse.status}): ${errText.slice(0, 180) || rowsResponse.statusText}`
    );
  }
  if (!countResponse.ok) {
    const errText = await countResponse.text().catch(() => '');
    throw new Error(
      `NYC Flood Events Count API error (HTTP ${countResponse.status}): ${errText.slice(0, 180) || countResponse.statusText}`
    );
  }

  const [rawRows, rawCount] = await Promise.all([rowsResponse.json(), countResponse.json()]);

  if (!Array.isArray(rawRows)) {
    throw new Error('Unexpected JSON format from NYC Open Data flood events endpoint.');
  }

  const totalCount =
    Array.isArray(rawCount) && rawCount[0]?.total_count != null
      ? Number(rawCount[0].total_count)
      : rawRows.length;

  const totalPages = Math.max(1, Math.ceil(totalCount / safePageSize));

  // If the requested page exceeded filtered totalPages, automatically re-fetch the valid clamped page
  let finalRows = rawRows;
  let finalPage = requestedPage;
  let finalOffset = offset;
  let finalUrl = rowsUrl;

  if (totalCount > 0 && requestedPage > totalPages) {
    finalPage = totalPages;
    finalOffset = (finalPage - 1) * safePageSize;
    const clampedParams = new URLSearchParams({
      ...sharedParams,
      $select: EVENT_SELECT_FIELDS,
      $order: 'flood_start_time DESC',
      $limit: String(safePageSize),
      $offset: String(finalOffset)
    });
    finalUrl = `${NYC_OPEN_DATA_ENDPOINTS.FLOOD_EVENTS}?${clampedParams.toString()}`;
    const clampedRes = await fetch(finalUrl, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal
    });
    if (clampedRes.ok) {
      finalRows = await clampedRes.json();
    }
  } else if (totalCount === 0) {
    finalPage = 1;
    finalOffset = 0;
  }

  // Join each flood event row with sensor deployment metadata via `sensor_id`
  const records = (Array.isArray(finalRows) ? finalRows : []).map((row) => {
    const meta = sensorById.get(row.sensor_id) || null;
    const maxDepthVal = row.max_depth_inches != null ? Number(row.max_depth_inches) : null;
    const durationVal = row.duration_mins != null ? Number(row.duration_mins) : null;
    const onsetVal = row.onset_time_mins != null ? Number(row.onset_time_mins) : null;
    const drainVal = row.drain_time_mins != null ? Number(row.drain_time_mins) : null;

    return {
      sensorId: row.sensor_id || '',
      sensorName: row.sensor_name || meta?.sensorName || row.sensor_id || 'Unknown Sensor',
      floodStartTime: row.flood_start_time || '',
      floodEndTime: row.flood_end_time || '',
      maxDepthInches: Number.isFinite(maxDepthVal) ? maxDepthVal : null,
      maxDepthInchesRaw: row.max_depth_inches ?? '',
      durationMins: Number.isFinite(durationVal) ? durationVal : null,
      durationMinsRaw: row.duration_mins ?? '',
      onsetTimeMins: Number.isFinite(onsetVal) ? onsetVal : null,
      drainTimeMins: Number.isFinite(drainVal) ? drainVal : null,
      // Joined location fields from sensor deployment metadata (kb2e-tjy3.json)
      borough: meta?.borough || '',
      streetName: meta?.streetName || '',
      zipcode: meta?.zipcode || '',
      nta: meta?.nta || '',
      tidallyInfluenced: meta?.tidallyInfluenced || '',
      dateInstalled: meta?.dateInstalled || '',
      latitude: meta?.latitude ?? null,
      longitude: meta?.longitude ?? null,
      hasJoinedMetadata: Boolean(meta)
    };
  });

  const latencyMs = Math.round(performance.now() - startedAt);

  return {
    records,
    totalCount,
    page: finalPage,
    pageSize: safePageSize,
    totalPages,
    offset: finalOffset,
    latencyMs,
    fetchedAtMs: Date.now(),
    requestUrl: finalUrl
  };
}
