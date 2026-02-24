// server.js
// Standalone Remoteness Scoring API for auto hauling
// Tech stack: Node.js + Express, no database

const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// --- Load ZIP data into memory ---
const zipsFilePath = path.join(__dirname, "zips.json");
let zipData = [];
let zipIndex = {};

function loadZipData() {
  try {
    const raw = fs.readFileSync(zipsFilePath, "utf8");
    zipData = JSON.parse(raw);

    zipIndex = {};
    zipData.forEach((z) => {
      if (z.zip) {
        zipIndex[String(z.zip)] = z;
      }
    });

    console.log(`Loaded ${zipData.length} ZIP records.`);
  } catch (err) {
    console.error("Error loading zips.json:", err.message);
    zipData = [];
    zipIndex = {};
  }
}

loadZipData();

// --- Utility: parse month safely (1–12) ---
function normalizeMonth(monthParam) {
  const m = parseInt(monthParam, 10);
  if (Number.isNaN(m) || m < 1 || m > 12) {
    // Default: current month
    return new Date().getMonth() + 1;
  }
  return m;
}

// --- Core scoring logic ---

function computeRemotenessComponents(zipRecord, month) {
  const components = {
    densityScore: 0,
    metroAccessScore: 0,
    roadTerrainScore: 0,
    carrierScore: 0,
    totalScore: 0,
  };

  if (!zipRecord) {
    return components;
  }

  const density = zipRecord.population_density ?? null;
  const driveCity = zipRecord.drive_time_city_100k_min ?? null;
  const driveInterstate = zipRecord.drive_time_interstate_min ?? null;
  const isMountain = !!zipRecord.is_mountain;
  const isIsland = !!zipRecord.is_island;
  const winterRisk = !!zipRecord.winter_risk;
  const carrierScarcity = zipRecord.carrier_scarcity_index ?? 0;

  // Density score
  if (density !== null) {
    if (density < 150) {
      components.densityScore += 2;
    } else if (density < 500) {
      components.densityScore += 1;
    }
  }

  // Metro access score
  if (driveCity !== null) {
    if (driveCity > 90) {
      components.metroAccessScore += 2;
    } else if (driveCity > 60) {
      components.metroAccessScore += 1;
    }
  }

  if (driveInterstate !== null && driveInterstate > 30) {
    components.metroAccessScore += 1;
  }

  // Terrain / geography
  if (isMountain) {
    components.roadTerrainScore += 1;
  }
  if (isIsland) {
    components.roadTerrainScore += 1;
  }

  // Winter season effect (Nov–Mar) if flagged
  const winterMonths = [11, 12, 1, 2, 3];
  if (winterRisk && winterMonths.includes(month)) {
    components.roadTerrainScore += 1;
  }

  // Carrier scarcity score (based on your historical data)
  if (carrierScarcity > 0.7) {
    components.carrierScore += 2;
  } else if (carrierScarcity > 0.4) {
    components.carrierScore += 1;
  }

  components.totalScore =
    components.densityScore +
    components.metroAccessScore +
    components.roadTerrainScore +
    components.carrierScore;

  return components;
}

function categorizeScore(totalScore) {
  if (totalScore <= 2) {
    return "URBAN_EASY";
  } else if (totalScore <= 4) {
    return "NORMAL";
  } else if (totalScore <= 6) {
    return "RURAL_DIFFICULT";
  } else {
    return "REMOTE_PREMIUM";
  }
}

function suggestedSurcharge(category) {
  // Tune these numbers to match your business
  switch (category) {
    case "URBAN_EASY":
      return { currency: "USD", type: "lump_sum", min: 0, max: 0 };
    case "NORMAL":
      return { currency: "USD", type: "lump_sum", min: 25, max: 50 };
    case "RURAL_DIFFICULT":
      return { currency: "USD", type: "lump_sum", min: 75, max: 150 };
    case "REMOTE_PREMIUM":
      return { currency: "USD", type: "lump_sum", min: 150, max: 300 };
    default:
      return { currency: "USD", type: "lump_sum", min: 0, max: 0 };
  }
}

// --- Express endpoints ---

// Simple health check
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// Score a single ZIP
app.get("/location-score", (req, res) => {
  const { zip, month } = req.query;

  if (!zip) {
    return res.status(400).json({ error: "Missing required parameter: zip" });
  }

  const monthNum = normalizeMonth(month);
  const record = zipIndex[String(zip)];

  if (!record) {
    return res.status(404).json({ error: `ZIP ${zip} not found in dataset` });
  }

  const components = computeRemotenessComponents(record, monthNum);
  const category = categorizeScore(components.totalScore);
  const surcharge = suggestedSurcharge(category);

  res.json({
    zip: record.zip,
    city: record.city,
    state: record.state,
    month: monthNum,
    components,
    category,
    suggested_surcharge: surcharge,
  });
});

// Score a trip (pickup + delivery)
app.get("/trip-score", (req, res) => {
  const { pickup_zip, delivery_zip, month } = req.query;

  if (!pickup_zip || !delivery_zip) {
    return res.status(400).json({
      error: "Missing required parameters: pickup_zip and delivery_zip",
    });
  }

  const monthNum = normalizeMonth(month);

  const pickupRecord = zipIndex[String(pickup_zip)];
  const deliveryRecord = zipIndex[String(delivery_zip)];

  if (!pickupRecord) {
    return res
      .status(404)
      .json({ error: `Pickup ZIP ${pickup_zip} not found in dataset` });
  }
  if (!deliveryRecord) {
    return res
      .status(404)
      .json({ error: `Delivery ZIP ${delivery_zip} not found in dataset` });
  }

  const pickupComponents = computeRemotenessComponents(pickupRecord, monthNum);
  const deliveryComponents = computeRemotenessComponents(
    deliveryRecord,
    monthNum
  );

  const pickupCategory = categorizeScore(pickupComponents.totalScore);
  const deliveryCategory = categorizeScore(deliveryComponents.totalScore);

  const pickupSurcharge = suggestedSurcharge(pickupCategory);
  const deliverySurcharge = suggestedSurcharge(deliveryCategory);

  // Simple rule: total surcharge = sum of endpoints (you can tune this)
  const totalSurcharge = {
    currency: "USD",
    type: "lump_sum",
    min: pickupSurcharge.min + deliverySurcharge.min,
    max: pickupSurcharge.max + deliverySurcharge.max,
  };

  res.json({
    month: monthNum,
    pickup: {
      zip: pickupRecord.zip,
      city: pickupRecord.city,
      state: pickupRecord.state,
      components: pickupComponents,
      category: pickupCategory,
      suggested_surcharge: pickupSurcharge,
    },
    delivery: {
      zip: deliveryRecord.zip,
      city: deliveryRecord.city,
      state: deliveryRecord.state,
      components: deliveryComponents,
      category: deliveryCategory,
      suggested_surcharge: deliverySurcharge,
    },
    total_suggested_surcharge: totalSurcharge,
  });
});

// Reload ZIP data without restarting (optional, you can call this with a tool like Postman)
app.post("/reload-zips", (req, res) => {
  loadZipData();
  res.json({ status: "reloaded", total_zips: zipData.length });
});

app.listen(PORT, () => {
  console.log(`Remoteness API listening on port ${PORT}`);
});
