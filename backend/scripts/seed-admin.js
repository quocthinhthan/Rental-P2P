const path = require('node:path');
const mongoose = require('mongoose');
const User = require('../models/User.model');

const adminEmail = 'admin@rentalhub.thanquocthinh.id.vn';

async function seedAdmin(password) {
  const filter = { email: adminEmail };
  let existingUser = await User.findOne(filter).select('role').lean();

  if (!existingUser) {
    if (!password) {
      throw new Error('Cần cung cấp ADMIN_SEED_PASSWORD để tạo tài khoản admin.');
    }

    await User.init();
    try {
      await User.create({ fullName: 'RentalHub Admin', email: adminEmail, password, role: 'admin' });
      return true;
    } catch (error) {
      if (error.code !== 11000 || !error.keyPattern?.email) throw error;
      existingUser = await User.findOne(filter).select('role').lean();
      if (!existingUser) throw error;
    }
  }

  if (existingUser.role !== 'admin') {
    throw new Error(`Email ${adminEmail} đã thuộc về tài khoản có quyền khác.`);
  }

  return false;
}

async function main() {
  require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), quiet: true });
  const { MONGO_URI, ADMIN_SEED_PASSWORD } = process.env;
  if (!MONGO_URI) throw new Error('Cần cung cấp MONGO_URI để kết nối MongoDB.');

  try {
    await mongoose.connect(MONGO_URI).catch(() => {
      throw new Error('Không thể kết nối MongoDB. Hãy kiểm tra cấu hình MONGO_URI.');
    });

    const created = await seedAdmin(ADMIN_SEED_PASSWORD);
    console.log(created ? `Đã tạo tài khoản admin ${adminEmail}.` : `Tài khoản admin ${adminEmail} đã tồn tại.`);
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(`Lỗi seed admin: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { seedAdmin };
