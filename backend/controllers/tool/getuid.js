const axios = require("axios");

// Cache UID để tránh gọi API nhiều lần cho cùng 1 link
const uidCache = new Map();
const CACHE_DURATION = 5 * 60 * 1000; // 5 phút

// Rate limiting: Theo dõi số request
const requestTracker = {
  count: 0,
  lastReset: Date.now(),
  maxPerMinute: 20 // Giới hạn 20 request/phút (tăng vì có 2 API)
};

// Danh sách User-Agent để rotate
const userAgents = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
];

// Helper: Lấy random User-Agent
function getRandomUserAgent() {
  return userAgents[Math.floor(Math.random() * userAgents.length)];
}

// Helper: Check rate limit
function checkRateLimit() {
  const now = Date.now();
  if (now - requestTracker.lastReset > 60000) {
    requestTracker.count = 0;
    requestTracker.lastReset = now;
  }
  requestTracker.count++;
  return requestTracker.count <= requestTracker.maxPerMinute;
}

// Helper: Random delay
function randomDelay(min = 300, max = 1000) {
  return new Promise(resolve => setTimeout(resolve, Math.random() * (max - min) + min));
}

// Helper: Generate Chrome version
function getChromeVersion() {
  const versions = ['130', '131', '132'];
  return versions[Math.floor(Math.random() * versions.length)];
}

// API 1: Traodoisub
async function getUidFromTraodoisub(link) {
  const chromeVersion = getChromeVersion();
  const userAgent = getRandomUserAgent();

  const headers = {
    "accept": "application/json, text/javascript, */*; q=0.01",
    "accept-language": "vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7",
    "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
    "origin": "https://id.traodoisub.com",
    "referer": "https://id.traodoisub.com/",
    "sec-ch-ua": `"Chromium";v="${chromeVersion}", "Google Chrome";v="${chromeVersion}", "Not?A_Brand";v="99"`,
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": `"Windows"`,
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "user-agent": userAgent,
    "x-requested-with": "XMLHttpRequest"
  };

  const data = new URLSearchParams();
  data.append("link", link);

  const response = await axios.post(
    "https://id.traodoisub.com/api.php",
    data.toString(),
    {
      headers,
      timeout: 10000,
      maxRedirects: 5,
      validateStatus: (status) => status < 500
    }
  );

  if (response.data.success && response.data.success == 200) {
    return { uid: response.data.id, source: 'traodoisub' };
  }
  throw new Error(response.data.error || 'Traodoisub API failed');
}

// API 2: Likenhanh
async function getUidFromLikenhanh(link) {
  const raw = JSON.stringify({ url: link });

  const response = await fetch("https://likenhanh.pro/api/get_uid", {
    method: 'POST',
    body: raw,
    headers: { 'Content-Type': 'application/json' },
    redirect: 'follow'
  });

  const result = await response.text();
  const responseData = JSON.parse(result);

  if (responseData && responseData.uid) {
    return { uid: responseData.uid, source: 'likenhanh' };
  }
  throw new Error('Likenhanh API failed');
}

/**
 * Controller xử lý chuyển đổi link thành UID với fallback.
 * @param {Request} req 
 * @param {Response} res 
 */
exports.getUid = async (req, res) => {
  const { link } = req.body;

  // Kiểm tra xem link có được gửi lên hay không
  if (!link) {
    return res.status(400).json({
      success: false,
      message: "Link is required",
    });
  }

  // Check rate limit
  if (!checkRateLimit()) {
    console.log('⚠️ Rate limit exceeded, waiting...');
    await randomDelay(2000, 4000);
  }

  // Kiểm tra tính hợp lệ của URL
  try {
    new URL(link);
  } catch (error) {
    return res.status(400).json({
      success: false,
      message: "Invalid URL",
    });
  }

  // Kiểm tra cache trước
  const cacheKey = link.toLowerCase().trim();
  const cached = uidCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
    console.log('✅ Cache hit cho link:', link);
    return res.json({
      success: true,
      uid: cached.uid,
      cached: true
    });
  }

  // Random delay nhẹ
  await randomDelay(300, 1000);

  let lastError = null;

  // Thử API 1: Traodoisub trước
  try {
    console.log('🔄 Đang thử API Traodoisub...');
    const result = await getUidFromTraodoisub(link);

    // Lưu vào cache
    uidCache.set(cacheKey, {
      uid: result.uid,
      source: result.source,
      timestamp: Date.now()
    });

    // Cleanup cache
    if (uidCache.size > 1000) {
      const firstKey = uidCache.keys().next().value;
      uidCache.delete(firstKey);
    }

    console.log(`✅ Thành công với ${result.source}`);
    return res.json({
      success: true,
      uid: result.uid,
      cached: false
    });
  } catch (error) {
    console.log(`⚠️ Traodoisub failed: ${error.message}`);
    lastError = error;
  }

  // Nếu API 1 lỗi, thử API 2: Likenhanh
  try {
    console.log('🔄 Đang thử API Likenhanh (fallback)...');
    await randomDelay(500, 1500); // Delay trước khi gọi API 2

    const result = await getUidFromLikenhanh(link);

    // Lưu vào cache
    uidCache.set(cacheKey, {
      uid: result.uid,
      source: result.source,
      timestamp: Date.now()
    });

    // Cleanup cache
    if (uidCache.size > 1000) {
      const firstKey = uidCache.keys().next().value;
      uidCache.delete(firstKey);
    }

    console.log(`✅ Thành công với ${result.source} (fallback)`);
    return res.json({
      success: true,
      uid: result.uid,
      cached: false,
      fallback: true
    });
  } catch (error) {
    console.log(`⚠️ Likenhanh failed: ${error.message}`);
    lastError = error;
  }

  // Cả 2 API đều lỗi
  console.error('❌ Cả 2 API đều thất bại');
  return res.status(500).json({
    success: false,
    message: "Lấy uid thất bại",
  });
};
