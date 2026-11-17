const path = require('path');
const mongoose = require('mongoose');
const Item = require('../models/Item.model');
const User = require('../models/User.model');

require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env'), quiet: true });
require('dotenv').config({ quiet: true });

const owners = [
  { name: 'Quốc Thịnh', id: '6afac10f034b2f56afa03091' },
  { name: 'Thịnh 287', id: '6afb279c098b1f3dbccb5e91' }
];

// Each category contains three products for each owner, in owner order.
const groups = [
  {
    category: 'Du lịch',
    places: [
      { address: 'Khu vực công viên Lê Văn Tám, Quận 1, TP.HCM', coordinates: [106.6942, 10.7917] },
      { address: 'Khu vực cầu Sài Gòn, TP. Thủ Đức, TP.HCM', coordinates: [106.7219, 10.8015] }
    ],
    products: [
      [
        ['Lều cắm trại 4 người chống mưa', 'Lều hai lớp có mái che, phù hợp cho gia đình đi cắm trại cuối tuần; kèm cọc và túi đựng.', 120000, 1800000, 50, true],
        ['Balo trekking 50 lít', 'Balo có đai hông và áo mưa, đủ chỗ cho đồ dùng cá nhân trong chuyến đi hai đến ba ngày.', 70000, 1200000, 50],
        ['Túi ngủ du lịch gọn nhẹ', 'Túi ngủ dạng chữ nhật dễ cuộn, phù hợp nghỉ đêm ở khu cắm trại hoặc homestay vùng mát.', 45000, 650000, 40]
      ],
      [
        ['Vali kéo 24 inch', 'Vali cỡ vừa có khóa số và bánh xoay, tiện cho chuyến công tác hoặc du lịch vài ngày.', 60000, 1100000, 50],
        ['Bếp gas mini dã ngoại', 'Bếp nhỏ gọn kèm hộp đựng, thích hợp nấu ăn khi dã ngoại; người thuê tự chuẩn bị bình gas phù hợp.', 50000, 550000, 50],
        ['Ghế xếp cắm trại có tựa lưng', 'Ghế xếp gọn có túi đựng, thuận tiện mang theo khi câu cá, đi biển hoặc cắm trại.', 35000, 450000, 40]
      ]
    ]
  },
  {
    category: 'Thiết bị điện',
    places: [
      { address: 'Khu vực chợ Bà Chiểu, quận Bình Thạnh, TP.HCM', coordinates: [106.6931, 10.8034] },
      { address: 'Khu vực ngã tư Bảy Hiền, quận Tân Bình, TP.HCM', coordinates: [106.6527, 10.7925] }
    ],
    products: [
      [
        ['Máy khoan điện cầm tay', 'Máy khoan dùng điện cho các việc sửa chữa nhỏ trong nhà, kèm bộ mũi khoan cơ bản.', 90000, 1500000, 60],
        ['Máy rửa xe áp lực gia đình', 'Máy rửa áp lực nhỏ gọn kèm súng phun và dây nước, phù hợp vệ sinh xe máy hoặc sân nhà.', 150000, 2800000, 60, true],
        ['Máy mài góc cầm tay', 'Máy mài góc dùng điện, phù hợp cắt và mài vật liệu khi sửa chữa nhỏ; kèm tay cầm phụ.', 85000, 1400000, 60]
      ],
      [
        ['Máy bắt vít dùng pin', 'Máy bắt vít cầm tay kèm pin, bộ sạc và đầu vít thông dụng, tiện lắp ráp đồ nội thất.', 100000, 1800000, 60],
        ['Ổ cắm kéo dài 10 mét', 'Cuộn dây điện dài 10 mét có nhiều ổ cắm, phù hợp cấp điện tạm thời cho gian hàng hoặc buổi họp.', 40000, 500000, 50],
        ['Đèn pha LED công trình 50 W', 'Đèn pha LED có chân đỡ, dùng chiếu sáng khu vực sửa chữa hoặc buổi sinh hoạt ngoài trời.', 65000, 800000, 50]
      ]
    ]
  },
  {
    category: 'Thiết bị gia dụng',
    places: [
      { address: 'Khu vực công viên Lê Thị Riêng, Quận 10, TP.HCM', coordinates: [106.6671, 10.7824] },
      { address: 'Khu vực cầu Phú Mỹ, Quận 7, TP.HCM', coordinates: [106.7430, 10.7340] }
    ],
    products: [
      [
        ['Nồi lẩu điện 4 lít', 'Nồi lẩu điện dung tích 4 lít, thích hợp cho bữa họp mặt gia đình hoặc nhóm bạn nhỏ.', 60000, 850000, 50],
        ['Máy hút bụi gia đình', 'Máy hút bụi có các đầu hút cơ bản, phù hợp dọn căn hộ sau khi chuyển nhà hoặc tổng vệ sinh.', 120000, 2200000, 60],
        ['Quạt đứng điều khiển từ xa', 'Quạt đứng điều chỉnh độ cao và tốc độ gió, dùng bổ sung khi nhà có khách hoặc tổ chức tiệc.', 65000, 1000000, 50]
      ],
      [
        ['Bếp từ đơn di động', 'Bếp từ đơn gọn nhẹ, phù hợp nấu ăn tạm thời; sử dụng với nồi có đáy nhiễm từ.', 65000, 900000, 50],
        ['Nồi chiên không dầu 5 lít', 'Nồi chiên dung tích 5 lít, phù hợp chế biến món ăn cho gia đình trong vài ngày.', 90000, 1700000, 60],
        ['Máy xay sinh tố để bàn', 'Máy xay có cối dung tích gia đình, tiện chuẩn bị nước ép và sinh tố cho buổi gặp mặt.', 55000, 800000, 50]
      ]
    ]
  },
  {
    category: 'Thể thao',
    places: [
      { address: 'Khu vực sân vận động Phú Thọ, Quận 11, TP.HCM', coordinates: [106.6571, 10.7645] },
      { address: 'Khu vực hồ Bán Nguyệt, Quận 7, TP.HCM', coordinates: [106.7198, 10.7290] }
    ],
    products: [
      [
        ['Bộ hai vợt cầu lông', 'Hai vợt cầu lông giải trí kèm túi đựng, phù hợp chơi cùng bạn bè tại sân gần nhà.', 50000, 800000, 50],
        ['Xe đạp thể thao địa hình', 'Xe đạp địa hình nhiều tốc độ, phù hợp đạp dạo và vận động trên các tuyến đường trong thành phố.', 150000, 4500000, 70, true],
        ['Thảm tập yoga dày 6 mm', 'Thảm tập yoga có dây buộc, phù hợp tập trong nhà hoặc mang đến lớp học.', 30000, 400000, 40]
      ],
      [
        ['Bộ hai vợt bóng bàn', 'Hai vợt bóng bàn giải trí kèm hộp đựng, thích hợp cho buổi chơi thử tại câu lạc bộ.', 45000, 650000, 50],
        ['Bóng đá sân 5', 'Bóng đá cỡ số 4 phù hợp sân bóng mini, có thể thuê cho trận giao hữu cùng đồng nghiệp.', 35000, 450000, 40],
        ['Bộ tạ tay điều chỉnh 20 kg', 'Bộ tạ tay tháo lắp được, tổng khối lượng 20 kg, phù hợp tập sức mạnh tại nhà.', 80000, 1400000, 60]
      ]
    ]
  },
  {
    category: 'Vật dụng văn phòng',
    places: [
      { address: 'Khu vực nhà thờ Tân Định, Quận 1, TP.HCM', coordinates: [106.6903, 10.7885] },
      { address: 'Khu vực công viên Gia Định, quận Gò Vấp, TP.HCM', coordinates: [106.6742, 10.8135] }
    ],
    products: [
      [
        ['Máy chiếu văn phòng Full HD', 'Máy chiếu hỗ trợ trình chiếu Full HD, phù hợp buổi họp nhóm hoặc đào tạo quy mô nhỏ.', 250000, 6500000, 70, true],
        ['Màn chiếu ba chân 100 inch', 'Màn chiếu gấp gọn kèm chân đỡ, thuận tiện cho buổi thuyết trình tại lớp học hoặc văn phòng.', 100000, 1600000, 50],
        ['Bảng trắng di động 1,2 mét', 'Bảng trắng có chân di chuyển, phù hợp ghi chú trong buổi họp hoặc lớp học ngắn ngày.', 80000, 1300000, 50]
      ],
      [
        ['Máy hủy giấy văn phòng', 'Máy hủy giấy cỡ nhỏ, phù hợp xử lý tài liệu cá nhân hoặc hồ sơ văn phòng không còn sử dụng.', 100000, 1800000, 60],
        ['Bộ bàn phím và chuột không dây', 'Bộ bàn phím và chuột không dây dùng cho bàn làm việc tạm thời hoặc sự kiện.', 45000, 700000, 50],
        ['Micro không dây thuyết trình', 'Micro không dây kèm đầu thu, phù hợp phát biểu trong phòng họp hoặc buổi đào tạo.', 120000, 2200000, 60]
      ]
    ]
  }
];

const items = groups.flatMap(({ category, places, products }) =>
  products.flatMap((ownerProducts, ownerIndex) =>
    ownerProducts.map(([name, description, pricePerDay, baseValue, depositPercentage, isFeatured = false]) => ({
      name, description, category, pricePerDay, baseValue, depositPercentage,
      ownerId: owners[ownerIndex].id,
      address: places[ownerIndex].address,
      location: { type: 'Point', coordinates: places[ownerIndex].coordinates },
      images: [], status: 'available', isFeatured
    }))
  )
);

function validateSeed() {
  const keys = new Set();
  for (const owner of owners) {
    if (!mongoose.isValidObjectId(owner.id)) {
      throw new Error(`ObjectId của ${owner.name} không hợp lệ: ${owner.id}`);
    }
  }
  for (const item of items) {
    const key = JSON.stringify([item.ownerId, item.name]);
    if (keys.has(key)) {
      throw new Error(`Tên sản phẩm bị trùng trong danh sách seed: ${item.name} (${item.ownerId})`);
    }
    keys.add(key);
  }
}

async function seed() {
  const counts = owners.map(() => ({ added: 0, skipped: 0 }));
  let connected = false;
  try {
    validateSeed();
    if (!process.env.MONGO_URI) throw new Error('Không tìm thấy MONGO_URI trong môi trường hoặc file .env.');
    try {
      await mongoose.connect(process.env.MONGO_URI);
      connected = true;
    } catch {
      throw new Error('Không thể kết nối MongoDB. Hãy kiểm tra MONGO_URI và kết nối mạng.');
    }

    const existingUsers = await User.find({ _id: { $in: owners.map(owner => owner.id) } }).select('_id').lean();
    const existingIds = new Set(existingUsers.map(user => String(user._id)));
    const missing = owners.filter(owner => !existingIds.has(owner.id));
    if (missing.length) {
      throw new Error(`Không tìm thấy user: ${missing.map(owner => `${owner.name} (${owner.id})`).join(', ')}. Không thêm sản phẩm nào.`);
    }

    for (const item of items) {
      const ownerIndex = owners.findIndex(owner => owner.id === item.ownerId);
      if (await Item.exists({ ownerId: item.ownerId, name: item.name })) {
        counts[ownerIndex].skipped++;
        continue;
      }
      try {
        await new Item(item).save();
        counts[ownerIndex].added++;
      } catch (error) {
        throw new Error(`Không thể lưu sản phẩm "${item.name}" của ${owners[ownerIndex].name}: ${error.message}`);
      }
    }
  } catch (error) {
    console.error(`Lỗi seed: ${error.message}`);
    process.exitCode = 1;
  } finally {
    for (const [index, owner] of owners.entries()) {
      console.log(`${owner.name}: đã thêm ${counts[index].added}, đã bỏ qua ${counts[index].skipped}.`);
    }
    if (connected || mongoose.connection.readyState !== 0) await mongoose.disconnect();
  }
}

if (require.main === module) {
  seed().catch(() => {
    console.error('Lỗi khi đóng kết nối MongoDB.');
    process.exitCode = 1;
  });
}

module.exports = { items, owners, validateSeed, seed };
