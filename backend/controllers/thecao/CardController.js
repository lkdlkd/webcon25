const crypto = require("crypto");
const axios = require("axios");
const Transaction = require("../../models/RechangeCard");
const FormData = require("form-data");
const Card = require("../../models/Card");
const ConfigCard = require("../../models/ConfigCard"); // Import mô hình ConfigCard

// Controller tạo transaction
exports.createTransaction = async (req, res) => {
  try {
    // Lấy user từ middleware
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: "Không xác thực được người dùng" });
    }

    const { card_type, card_value, card_seri, card_code } = req.body;
    if (!card_type || !card_value || !card_seri || !card_code) {
      return res.status(400).json({ error: "Không được để trống" });
    }

    // Lấy request_id tăng dần
    const lastTransaction = await Transaction.findOne().sort({ request_id: -1 });

    let request_id = 101;
    if (lastTransaction && typeof lastTransaction.request_id === "number") {
      request_id = lastTransaction.request_id + 1;
    }

    let trans_id = 1;
    if (lastTransaction && typeof lastTransaction.tran_id === "number") {
      trans_id = lastTransaction.tran_id + 1;
    }

    // Lấy cấu hình từ ConfigCard
    const configCard = await ConfigCard.findOne();
    if (!configCard) {
      return res.status(500).json({ error: "Cấu hình thẻ nạp không tồn tại" });
    }

    const partner_id = configCard.PARTNER_ID;
    const partner_key = configCard.PARTNER_KEY;
    const api_urlcard = configCard.API_URLCARD;

    const sign = crypto
      .createHash("md5")
      .update(partner_key + card_code + card_seri)
      .digest("hex");

    const command = "charging";
    // Tạo form-data để gửi đến API đối tác
    const formdata = new FormData();
    formdata.append("telco", card_type);
    formdata.append("code", card_code);
    formdata.append("serial", card_seri);
    formdata.append("amount", card_value);
    formdata.append("request_id", request_id);
    formdata.append("partner_id", partner_id);
    formdata.append("sign", sign);
    formdata.append("command", command);

    const response = await axios.post(`${api_urlcard}/chargingws/v2`, formdata, {
      headers: {
        ...formdata.getHeaders(),
      },
    });

    // Lấy phí cao nhất từ bảng Card
    const cardInfo = await Card.findOne({ telco: card_type }).sort({ fees: -1 });
    const percent_card = cardInfo ? Number(cardInfo.fees) : 0;
    const chietkhau = card_value - (card_value * percent_card) / 100;


    if (response.data.status === 3) {
      return res.status(500).json({ error: "Thẻ lỗi, kiểm tra lại thẻ" });
    }
    if (response.data.status === 4) {
      return res.status(500).json({ error: "Thẻ lỗi, kiểm tra lại thẻ" });
    }
    if (response.data.status === 102) {
      return res.status(500).json({ error: "Nạp thẻ thất bại, vui lòng thử lại sau" });
    }
        if (response.data.status === 100) {
      return res.status(500).json({ error: "Nạp thẻ thất bại, vui lòng thử lại sau" });
    }

    // Tạo bản ghi Transaction mới với request_id tăng dần
    const newTransaction = await Transaction.create({
      code: card_code,
      username: user.username,
      type: card_type,
      amount: card_value,
      serial: card_seri,
      real_amount: chietkhau,
      request_id: request_id,
      tran_id: trans_id,
      mota: "Nạp thẻ cào",
    });

    return res.status(201).json({
      message: "Nạp thẻ thành công",
    });
  } catch (error) {
    console.error("Error creating transaction:", error.message);
    return res.status(500).json({ error: error.message });
  }
};

// Lấy danh sách các loại thẻ và mệnh giá, phí, penalty
exports.getCard = async (req, res) => {
  try {
    // Có thể lọc theo telco nếu truyền query: ?telco=VIETTEL
    const filter = {};
    if (req.query.telco) {
      filter.telco = req.query.telco;
    }
    const cards = await Card.find(filter).sort({ telco: 1, value: 1 });
    res.status(200).json({ success: true, data: cards });
  } catch (error) {
    res.status(500).json({ success: false, message: "Lỗi server", error: error.message });
  }
};

exports.GetHistoryCard = async (req, res) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: "Không xác thực được người dùng" });
    }

    let filter = {};
    if (user.role !== "admin") {
      // User thường: chỉ lấy giao dịch của chính mình
      filter.username = user.username;
    }
    // Nếu là admin: lấy tất cả giao dịch

    const transactions = await Transaction.find(filter)
      .select("createdAt type amount serial code real_amount status username")
      .sort({ createdAt: -1 })
      .limit(20);

    return res.status(200).json({ transactions });
  } catch (error) {
    console.error("Get balance error:", error);
    return res
      .status(500)
      .json({ error: "Có lỗi xảy ra. Vui lòng thử lại sau." });
  }
};
