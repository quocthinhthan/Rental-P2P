const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const mongoose = require('mongoose');
const { items, owners } = require('./seed-items');
const Item = require('../models/Item.model');
const cloudinary = require('../config/cloudinary');

const imageExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const maxImages = 5;
const maxImageSize = 5 * 1024 * 1024;
const ownerNames = new Map(owners.map(({ id, name }) => [id, name]));
const cloudinaryKeys = ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET'];
// Use the verified item code when a seeded product was renamed after import.
const renamedItemCodes = new Map([['Bộ hai vợt cầu lông', 'SPEFFMU5SW']]);

function productFolder(root, item) {
  return path.join(root, ownerNames.get(item.ownerId), item.name);
}

async function collectImages(root) {
  if (!(await fs.stat(root).catch(() => null))?.isDirectory()) {
    throw new Error(`Không tìm thấy thư mục ảnh tại ${root}. Hãy chạy với --prepare trước.`);
  }

  const staged = [];
  for (const item of items) {
    const folder = productFolder(root, item);
    const entries = await fs.readdir(folder, { withFileTypes: true }).catch((error) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    const files = entries
      .filter(entry => entry.isFile() && imageExtensions.has(path.extname(entry.name).toLowerCase()))
      .map(entry => entry.name)
      .sort((a, b) => a.localeCompare(b, 'vi', { numeric: true }));
    if (!files.length) continue;

    const label = `${ownerNames.get(item.ownerId)} / ${item.name}`;
    if (files.length > maxImages) {
      throw new Error(`${label}: chỉ nhận tối đa ${maxImages} ảnh.`);
    }
    for (const file of files) {
      const { size } = await fs.stat(path.join(folder, file));
      if (size === 0 || size > maxImageSize) {
        throw new Error(`${label} / ${file}: file rỗng hoặc vượt quá 5 MB.`);
      }
    }
    staged.push({ item, label, folder, files });
  }
  return staged;
}

async function uploadImage(file, itemId) {
  const contents = await fs.readFile(file);
  const hash = crypto.createHash('sha256').update(contents).digest('hex');
  const publicId = `seed-item-images/${itemId}/${hash}`;
  let result = await new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { resource_type: 'image', public_id: publicId, overwrite: false },
      (error, uploaded) => error ? reject(error) : resolve(uploaded)
    );
    stream.end(contents);
  });
  if (result?.existing && !result.secure_url) {
    result = await cloudinary.api.resource(publicId, { resource_type: 'image' });
  }
  if (!result?.secure_url) throw new Error('Cloudinary không trả về URL ảnh.');
  return result.secure_url;
}

async function run() {
  const args = process.argv.slice(2);
  const mode = args.at(-1)?.startsWith('--') ? args.pop() : undefined;
  const [directory, ...extra] = args;
  if (directory?.startsWith('--') || extra.length || (mode && !['--prepare', '--apply'].includes(mode))) {
    throw new Error('Cách dùng: node scripts/import-seed-item-images.js [thư mục ảnh] [--prepare | --apply]');
  }
  const root = path.resolve(directory || path.join(os.homedir(), 'Downloads', 'Rental-P2P-Images'));
  if (mode === '--prepare') {
    for (const item of items) await fs.mkdir(productFolder(root, item), { recursive: true });
    console.log(`Đã chuẩn bị ${items.length} thư mục sản phẩm tại ${root}`);
    return;
  }

  const staged = await collectImages(root);
  if (!staged.length) {
    console.log('Chưa có ảnh JPG, PNG hoặc WebP trong các thư mục sản phẩm.');
    return;
  }

  if (!process.env.MONGO_URI) throw new Error('Thiếu MONGO_URI trong .env.');
  try {
    await mongoose.connect(process.env.MONGO_URI, { autoCreate: false, autoIndex: false });
  } catch {
    throw new Error('Không thể kết nối MongoDB. Hãy kiểm tra cấu hình và kết nối mạng.');
  }

  const filters = staged.flatMap(({ item: { ownerId, name } }) => {
    const code = renamedItemCodes.get(name);
    return code ? [{ ownerId, name }, { ownerId, code }] : [{ ownerId, name }];
  });
  const matches = await Item.find({ $or: filters }).select('ownerId name code images').lean().catch(() => {
    throw new Error('Không thể đọc danh sách sản phẩm từ MongoDB.');
  });
  const batch = [];
  let skipped = 0;
  for (const entry of staged) {
    const code = renamedItemCodes.get(entry.item.name);
    const found = matches.filter(item => String(item.ownerId) === entry.item.ownerId &&
      (item.name === entry.item.name || (code && item.code === code)));
    if (found.length !== 1) {
      throw new Error(`${entry.label}: tìm thấy ${found.length} sản phẩm, cần đúng 1. Chưa tải ảnh nào.`);
    }
    if (found[0].images?.length) {
      console.log(`Bỏ qua ${entry.label}: sản phẩm đã có ảnh.`);
      skipped++;
      continue;
    }
    batch.push({ ...entry, itemId: found[0]._id });
    const label = found[0].name === entry.item.name ? entry.label : `${entry.label} → ${found[0].name}`;
    console.log(`${label}: ${entry.files.join(', ')}`);
  }

  if (mode !== '--apply') {
    console.log(`Xem trước: ${batch.length} sản phẩm sẵn sàng, ${skipped} bỏ qua. Thêm --apply để nhập.`);
    return;
  }

  const missingKeys = cloudinaryKeys.filter(key => !process.env[key]);
  if (batch.length && missingKeys.length) {
    throw new Error(`Thiếu cấu hình Cloudinary trong .env: ${missingKeys.join(', ')}.`);
  }

  let updated = 0;
  let failed = 0;
  for (const { itemId, label, folder, files } of batch) {
    const urls = new Set();
    let uploadFailed = false;
    for (const file of files) {
      try {
        urls.add(await uploadImage(path.join(folder, file), itemId));
      } catch (error) {
        const status = Number.isInteger(error?.http_code) ? ` (HTTP ${error.http_code})` : '';
        console.error(`Lỗi tải ảnh ${label} / ${file}${status}. Kiểm tra file và cấu hình Cloudinary.`);
        uploadFailed = true;
        break;
      }
    }
    if (uploadFailed) {
      failed++;
      continue;
    }
    try {
      const result = await Item.updateOne(
        { _id: itemId, 'images.0': { $exists: false } },
        { $set: { images: [...urls] } },
        { runValidators: true }
      );
      if (result.modifiedCount) {
        updated++;
        console.log(`Đã gắn ${urls.size} ảnh cho ${label}.`);
      } else {
        skipped++;
        console.log(`Bỏ qua ${label}: sản phẩm đã có ảnh hoặc đã bị xóa.`);
      }
    } catch {
      failed++;
      console.error(`Không thể lưu URL ảnh cho ${label} vào MongoDB.`);
    }
  }
  console.log(`Đã cập nhật ${updated} sản phẩm, bỏ qua ${skipped}, lỗi ${failed}.`);
  if (failed) process.exitCode = 1;
}

run()
  .catch((error) => {
    process.exitCode = 1;
    console.error(error.message);
  })
  .finally(async () => {
    try {
      await mongoose.disconnect();
    } catch {
      process.exitCode = 1;
      console.error('Không thể đóng kết nối MongoDB.');
    }
  });
