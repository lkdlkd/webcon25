const mongoose = require("mongoose");

const configwebSchema = new mongoose.Schema({
  tieude: { type: String, default: "" },
  title: { type: String, default: "" },
  logo: { type: String, default: "" },
  favicon: { type: String, default: "" },
  linktele: { type: String, default: "" },
  cuphap: { type: String, default: "naptien" },
  daily: {type : Number, default: 1000000}, // hoa hồng đại lý
  distributor: {type : Number, default: 10000000}, // hoa hồng nhà phân phối
  lienhe: [
    {
      type: { type: String, default: "" },
      value: { type: String, default: "" },
      logolienhe: { type: String, default: "" },
    },
  ],
  domain: { type: String, default: null },

}, { timestamps: true });

module.exports = mongoose.model("Configweb", configwebSchema);