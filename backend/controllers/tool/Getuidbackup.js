// const axios = require("axios");

// // Cache UID để tránh gọi API nhiều lần cho cùng 1 link
// const uidCache = new Map();
// const CACHE_DURATION = 5 * 60 * 1000; // 5 phút

// // Rate limiting: Theo dõi số request
// const requestTracker = {
//   count: 0,
//   lastReset: Date.now(),
//   maxPerMinute: 10 // Giới hạn 10 request/phút
// };

// // Danh sách User-Agent để rotate (cập nhật phiên bản mới nhất)
// const userAgents = [
//   "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
//   "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
//   "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
//   "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0",
//   "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15",
//   "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
// ];

// // Helper: Lấy random User-Agent
// function getRandomUserAgent() {
//   return userAgents[Math.floor(Math.random() * userAgents.length)];
// }

// // Helper: Check rate limit
// function checkRateLimit() {
//   const now = Date.now();
//   if (now - requestTracker.lastReset > 60000) {
//     requestTracker.count = 0;
//     requestTracker.lastReset = now;
//   }
//   requestTracker.count++;
//   return requestTracker.count <= requestTracker.maxPerMinute;
// }

// // Helper: Random delay để tránh bị phát hiện bot (tăng delay)
// function randomDelay(min = 500, max = 2000) {
//   return new Promise(resolve => setTimeout(resolve, Math.random() * (max - min) + min));
// }

// // Helper: Generate realistic Chrome version
// function getChromeVersion() {
//   const versions = ['130', '131', '132'];
//   return versions[Math.floor(Math.random() * versions.length)];
// }

// // Helper: Retry với exponential backoff
// async function retryWithBackoff(fn, maxRetries = 3, baseDelay = 1000) {
//   for (let i = 0; i < maxRetries; i++) {
//     try {
//       return await fn();
//     } catch (error) {
//       if (i === maxRetries - 1) throw error;
//       const delay = baseDelay * Math.pow(2, i) + Math.random() * 1000;
//       console.log(`⚠️ Retry ${i + 1}/${maxRetries} sau ${Math.round(delay)}ms...`);
//       await new Promise(resolve => setTimeout(resolve, delay));
//     }
//   }
// }

// /**
//  * Controller xử lý chuyển đổi link thành UID.
//  * @param {Request} req 
//  * @param {Response} res 
//  */
// exports.getUid = async (req, res) => {
//   const { link } = req.body;

//   // Kiểm tra xem link có được gửi lên hay không
//   if (!link) {
//     return res.status(400).json({
//       success: false,
//       message: "Link is required",
//     });
//   }

//   // Check rate limit
//   if (!checkRateLimit()) {
//     console.log('⚠️ Rate limit exceeded, waiting...');
//     await randomDelay(3000, 5000); // Đợi lâu hơn nếu vượt rate limit
//   }

//   // Kiểm tra tính hợp lệ của URL
//   try {
//     new URL(link);
//   } catch (error) {
//     return res.status(400).json({
//       success: false,
//       message: "Invalid URL",
//     });
//   }

//   // Kiểm tra cache trước
//   const cacheKey = link.toLowerCase().trim();
//   const cached = uidCache.get(cacheKey);
//   if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
//     console.log('✅ Cache hit cho link:', link);
//     return res.json({
//       success: true,
//       uid: cached.uid,
//       cached: true
//     });
//   }

//   // Random delay dài hơn để tránh spam (500ms - 2s)
//   await randomDelay(500, 2000);

//   const chromeVersion = getChromeVersion();
//   const userAgent = getRandomUserAgent();

//   // Cấu hình headers với thông tin realistic hơn
//   const headers = {
//     "accept": "application/json, text/javascript, */*; q=0.01",
//     "accept-language": "vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7",
//     "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
//     "cache-control": "no-cache",
//     "pragma": "no-cache",
//     "origin": "https://id.traodoisub.com",
//     "referer": "https://id.traodoisub.com/",
//     "sec-ch-ua": `"Chromium";v="${chromeVersion}", "Google Chrome";v="${chromeVersion}", "Not?A_Brand";v="99"`,
//     "sec-ch-ua-mobile": "?0",
//     "sec-ch-ua-platform": `"Windows"`,
//     "sec-fetch-dest": "empty",
//     "sec-fetch-mode": "cors",
//     "sec-fetch-site": "same-origin",
//     "user-agent": userAgent,
//     "x-requested-with": "XMLHttpRequest",
//     "dnt": "1",
//     "upgrade-insecure-requests": "1"
//   };

//   // Tạo body dạng URL-encoded
//   const data = new URLSearchParams();
//   data.append("link", link);

//   try {
//     // Gọi API với retry logic ít hơn (2 lần thôi)
//     const responseData = await retryWithBackoff(async () => {
//       const response = await axios.post(
//         "https://id.traodoisub.com/api.php",
//         data.toString(),
//         {
//           headers,
//           timeout: 15000, // Tăng timeout lên 15s
//           maxRedirects: 5,
//           validateStatus: (status) => status < 500 // Chấp nhận 4xx codes
//         }
//       );
//       return response.data;
//     }, 2, 2000); // Chỉ retry 2 lần, delay 2s

//     // Nếu API trả về thành công (success == 200)
//     if (responseData.success && responseData.success == 200) {
//       // Lưu vào cache
//       uidCache.set(cacheKey, {
//         uid: responseData.id,
//         timestamp: Date.now()
//       });

//       // Cleanup cache cũ (giữ tối đa 1000 entries)
//       if (uidCache.size > 1000) {
//         const firstKey = uidCache.keys().next().value;
//         uidCache.delete(firstKey);
//       }

//       return res.json({
//         success: true,
//         uid: responseData.id,
//         cached: false
//       });
//     } else {
//       return res.status(400).json({
//         success: false,
//         message: responseData.error || "Không thể lấy UID",
//       });
//     }
//   } catch (error) {
//     console.error("❌ Error calling external API:", error.message);

//     // Nếu bị rate limit/chặn, thông báo rõ ràng
//     if (error.response?.status === 429 || error.response?.status === 403) {
//       return res.status(429).json({
//         success: false,
//         message: "Tạm thời bị giới hạn, vui lòng thử lại sau",
//         retryAfter: 60
//       });
//     }

//     return res.status(500).json({
//       success: false,
//       message: "Internal server error",
//       error: error.message
//     });
//   }
// };

// Cache UID để tránh gọi API nhiều lần cho cùng 1 link
const uidCache = new Map();
const CACHE_DURATION = 5 * 60 * 1000; // 5 phút

exports.getUid = async (req, res) => {
  const { link } = req.body;
  if (!link) {
    return res.status(400).json({
      status: "error",
      message: "Link is required",
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

  try {
    var raw = `{\r\n  \"url\": \"${link}\"\r\n}`;

    var requestOptions = {
      method: 'POST',
      body: raw,
      redirect: 'follow'
    };

    fetch("https://likenhanh.pro/api/get_uid", requestOptions)
      .then(response => response.text())
      .then(result => {
        const responseData = JSON.parse(result);
        if (responseData && responseData.uid) {
          // Lưu vào cache
          uidCache.set(cacheKey, {
            uid: responseData.uid,
            timestamp: Date.now()
          });

          // Cleanup cache cũ (giữ tối đa 1000 entries)
          if (uidCache.size > 1000) {
            const firstKey = uidCache.keys().next().value;
            uidCache.delete(firstKey);
          }

          return res.json({
            success: true,
            uid: responseData.uid,
            cached: false
          });
        } else {
          return res.status(400).json({
            success: false,
            message: "Không thể lấy UID",
          });
        }
      })
      .catch(error => {
        console.log('error', error);
        return res.status(500).json({
          success: false,
          message: "Internal server error",
        });
      });
  } catch (error) {
    console.error("Error calling like5s API:", error?.response?.data || error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};