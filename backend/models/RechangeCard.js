const mongoose = require("mongoose");

const TransactionSchema = new mongoose.Schema({
  username: { type: String, required: true },
  type: { type: String, required: true },
  serial: { type: String, required: true },
  code: { type: String, required: true },
  amount: { type: Number, required: true },
  real_amount: { type: Number, required: false, default: 0 },
  request_id: { type: Number, required: false },
  pin: { type: Number, required: false, min: 10000 },
  status: { type: String, enum: ["pending", "success", "failed", "warning"], default: "pending" },
  tran_id: { type: Number, required: true },
  mota: { type: String, required: false },
  domain: { type: String, default: null },

}, { timestamps: true });

// Pre-save hook để tự động tăng giá trị pin
TransactionSchema.pre("save", async function (next) {
  // Chỉ chạy cho bản ghi mới
  if (this.isNew) {
    // Nếu pin chưa được thiết lập hoặc bằng undefined
    if (!this.pin) {
      // Tìm bản ghi có pin cao nhất
      const lastTransaction = await this.constructor.findOne().sort({ pin: -1 });
      if (lastTransaction && lastTransaction.pin) {
        this.pin = lastTransaction.pin + 1;
      } else {
        // Nếu chưa có giao dịch nào, bắt đầu từ 10000
        this.pin = 10000;
      }
    }
  }
  next();
});

const Transaction = mongoose.model("Transaction", TransactionSchema);

module.exports = Transaction;
