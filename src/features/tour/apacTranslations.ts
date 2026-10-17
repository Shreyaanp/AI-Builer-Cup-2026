import type { Locale } from '../../i18n/locales.js'
import type { TourCopy } from './strings.js'

/** The guided tour in the other APAC languages; keys missing here fall back to English. */
export const tourApac: Partial<Record<Locale, Partial<TourCopy>>> = {
  'zh-Hans': {
    offerTitle: '先看看它如何运作',
    offerBody: '花一分钟参观一家填好数据的示范店：预测、日结、供应商。',
    offerButton: '开始导览',
    preparing: '正在准备您的示范店…',
    failed: '无法准备示范店，请重试。',
    settings: '开始导览',
    narration: '朗读',
    next: '下一步',
    back: '上一步',
    skip: '跳过',
    stepOf: '{n} / {total}',
    steps: [
      {
        title: '店铺一览',
        body: '这是一家有六周销售数据的示范店。您和助手对话时，这里会随之更新。',
      },
      { title: '按类别排列的菜单', body: '点按价格即可修改。售罄的商品会立即显示在顾客页面上。' },
      { title: '明天的备货计划', body: '根据您的销售预测，做得够又少浪费。' },
      {
        title: '一分钟完成日结',
        body: '每晚拍下收银报表、到货和库存。Chalkboard 读取，您核对一次。',
      },
      {
        title: '快用完了？找供应商',
        body: '告诉助手“面粉快用完了”。它会找到附近的供应商，您在聊天中下单。',
      },
      {
        title: '说或打字都行',
        body: '“咖啡现在两块，咖椰吐司卖完了。”在您确认之前，什么都不会改变。',
      },
      { title: '一步步上 Google', body: '您的资料和照片会整理成一份可用的 Google 商家资料。' },
      { title: '分享您的页面', body: '顾客扫描您的二维码，查看今日菜单、提问并集印章。' },
    ],
    doneTitle: '准备好了',
    doneBody: '随意浏览示范店，或用一分钟开设您自己的店。',
    startMine: '开设我的店',
    keepExploring: '继续浏览',
  },
  ms: {
    offerTitle: 'Lihat cara ia berfungsi dahulu',
    offerBody: 'Lawatan seminit ke kedai demo yang lengkap: ramalan, tutup hari, pembekal.',
    offerButton: 'Mulakan lawatan',
    preparing: 'Menyediakan kedai demo anda…',
    failed: 'Tidak dapat menyediakan kedai demo. Sila cuba lagi.',
    settings: 'Mulakan lawatan',
    narration: 'Baca dengan kuat',
    next: 'Seterusnya',
    back: 'Kembali',
    skip: 'Langkau',
    stepOf: '{n} daripada {total}',
    steps: [
      {
        title: 'Kedai anda sepintas lalu',
        body: 'Ini kedai demo dengan jualan enam minggu. Semuanya dikemas kini semasa anda bercakap dengan jurulatih.',
      },
      {
        title: 'Menu anda, ikut kategori',
        body: 'Ketik harga untuk menukarnya. Item habis dijual terus dipaparkan di halaman pelanggan.',
      },
      {
        title: 'Pelan persediaan esok',
        body: 'Ramalan daripada jualan anda, supaya cukup dibuat dan kurang membazir.',
      },
      {
        title: 'Tutup hari dalam seminit',
        body: 'Setiap petang, ambil gambar laporan kaunter, penghantaran dan stok. Chalkboard membacanya; anda semak sekali.',
      },
      {
        title: 'Hampir habis? Cari pembekal',
        body: 'Beritahu jurulatih “tepung saya hampir habis”. Ia mencari pembekal berdekatan dan anda memesan dalam sembang.',
      },
      {
        title: 'Cakap atau taip sahaja',
        body: '“Kopi sekarang dua ringgit, roti bakar kaya habis.” Tiada yang berubah sehingga anda sahkan.',
      },
      {
        title: 'Ke Google, berpandu',
        body: 'Butiran dan gambar anda menjadi profil Google yang sedia.',
      },
      {
        title: 'Kongsi halaman anda',
        body: 'Pelanggan imbas QR anda untuk melihat menu hari ini, bertanya dan mengumpul setem.',
      },
    ],
    doneTitle: 'Anda sudah sedia',
    doneBody:
      'Teroka kedai demo selama mana anda mahu, atau sediakan kedai anda sendiri dalam seminit.',
    startMine: 'Mulakan kedai saya',
    keepExploring: 'Terus meneroka',
  },
  ja: {
    offerTitle: 'まず動くところを見る',
    offerBody: 'データ入りのデモ店を1分で案内します：予測、日次締め、仕入れ先。',
    offerButton: 'ツアーを始める',
    preparing: 'デモ店を準備しています…',
    failed: 'デモ店を準備できませんでした。もう一度お試しください。',
    settings: 'ツアーを始める',
    narration: '読み上げる',
    next: '次へ',
    back: '戻る',
    skip: 'スキップ',
    stepOf: '{n} / {total}',
    steps: [
      {
        title: 'お店をひと目で',
        body: '6週間分の売上があるデモ店です。コーチと話すたびに更新されます。',
      },
      {
        title: 'カテゴリ別のメニュー',
        body: '価格をタップして変更。売り切れはすぐにお客様ページに表示されます。',
      },
      { title: '明日の仕込み計画', body: '売上から予測するので、作りすぎず足りなくもなりません。' },
      {
        title: '1分で日次締め',
        body: '毎晩、レジ報告・入荷・在庫を撮影。Chalkboard が読み取り、確認は一度だけ。',
      },
      {
        title: '足りない？仕入れ先を探す',
        body: 'コーチに「小麦粉が残り少ない」と伝えると、近くの仕入れ先を探し、チャットで注文できます。',
      },
      {
        title: '話すか入力するだけ',
        body: '「抹茶ラテは500円に、どら焼きは売り切れ」。確認するまで何も変わりません。',
      },
      {
        title: 'Google へ、ガイド付きで',
        body: 'お店の情報と写真から Google のプロフィールを準備します。',
      },
      {
        title: 'ページを共有',
        body: 'お客様は QR を読み取って今日のメニューを見たり、質問したり、スタンプを集めたりできます。',
      },
    ],
    doneTitle: '準備完了',
    doneBody: 'デモ店を好きなだけ見るか、1分で自分のお店を作りましょう。',
    startMine: '自分のお店を始める',
    keepExploring: 'このまま見る',
  },
  ko: {
    offerTitle: '먼저 작동하는 모습을 보세요',
    offerBody: '데이터가 채워진 데모 가게를 1분 동안 둘러보세요: 예측, 하루 마감, 공급업체.',
    offerButton: '둘러보기',
    preparing: '데모 가게를 준비하는 중…',
    failed: '데모 가게를 준비하지 못했어요. 다시 시도해 주세요.',
    settings: '둘러보기',
    narration: '소리 내어 읽기',
    next: '다음',
    back: '이전',
    skip: '건너뛰기',
    stepOf: '{total}개 중 {n}',
    steps: [
      {
        title: '가게 한눈에 보기',
        body: '6주치 매출이 있는 데모 가게예요. 코치와 대화하면 여기 모든 것이 업데이트돼요.',
      },
      {
        title: '카테고리별 메뉴',
        body: '가격을 탭해서 바꾸세요. 품절은 고객 페이지에 바로 표시돼요.',
      },
      { title: '내일 준비 계획', body: '매출로 예측해서 충분히 만들고 덜 버리게 해요.' },
      {
        title: '1분 만에 하루 마감',
        body: '매일 저녁 계산대 보고서, 입고, 재고를 찍으세요. Chalkboard가 읽고, 확인은 한 번만.',
      },
      {
        title: '부족하세요? 공급업체 찾기',
        body: '코치에게 “밀가루가 떨어져 가”라고 말하면 근처 공급업체를 찾아 채팅으로 주문할 수 있어요.',
      },
      {
        title: '말하거나 입력하세요',
        body: '“아메리카노 이제 4,500원, 붕어빵 품절.” 확인하기 전까지는 아무것도 바뀌지 않아요.',
      },
      { title: 'Google에 등록, 단계별로', body: '가게 정보와 사진으로 Google 프로필을 준비해요.' },
      {
        title: '페이지 공유',
        body: '고객이 QR을 스캔해 오늘 메뉴를 보고, 질문하고, 스탬프를 모아요.',
      },
    ],
    doneTitle: '준비 완료',
    doneBody: '데모 가게를 마음껏 둘러보거나 1분 만에 내 가게를 만들어 보세요.',
    startMine: '내 가게 시작하기',
    keepExploring: '계속 둘러보기',
  },
  id: {
    offerTitle: 'Lihat cara kerjanya dulu',
    offerBody: 'Tur satu menit di toko demo yang sudah terisi: perkiraan, tutup hari, pemasok.',
    offerButton: 'Mulai tur',
    preparing: 'Menyiapkan toko demo Anda…',
    failed: 'Gagal menyiapkan toko demo. Silakan coba lagi.',
    settings: 'Mulai tur',
    narration: 'Bacakan',
    next: 'Berikutnya',
    back: 'Kembali',
    skip: 'Lewati',
    stepOf: '{n} dari {total}',
    steps: [
      {
        title: 'Toko Anda sekilas',
        body: 'Ini toko demo dengan penjualan enam minggu. Semuanya diperbarui saat Anda bicara dengan pelatih.',
      },
      {
        title: 'Menu Anda, per kategori',
        body: 'Ketuk harga untuk mengubahnya. Barang habis langsung tampil di halaman pelanggan.',
      },
      {
        title: 'Rencana persiapan besok',
        body: 'Perkiraan dari penjualan Anda, supaya cukup dan tidak banyak terbuang.',
      },
      {
        title: 'Tutup hari dalam semenit',
        body: 'Setiap sore, foto laporan kasir, barang masuk, dan stok. Chalkboard membacanya; Anda cek sekali.',
      },
      {
        title: 'Hampir habis? Cari pemasok',
        body: 'Bilang ke pelatih “tepung saya hampir habis”. Ia mencari pemasok terdekat dan Anda memesan lewat chat.',
      },
      {
        title: 'Cukup bicara atau ketik',
        body: '“Kopi susu sekarang 18 ribu, martabak habis.” Tidak ada yang berubah sampai Anda konfirmasi.',
      },
      {
        title: 'Masuk Google, dipandu',
        body: 'Detail dan foto Anda menjadi profil Google yang siap.',
      },
      {
        title: 'Bagikan halaman Anda',
        body: 'Pelanggan memindai QR Anda untuk melihat menu hari ini, bertanya, dan mengumpulkan stempel.',
      },
    ],
    doneTitle: 'Anda siap',
    doneBody: 'Jelajahi toko demo sepuasnya, atau siapkan toko Anda sendiri dalam semenit.',
    startMine: 'Mulai toko saya',
    keepExploring: 'Terus menjelajah',
  },
  th: {
    offerTitle: 'ดูการทำงานก่อน',
    offerBody: 'ทัวร์หนึ่งนาทีในร้านตัวอย่างที่มีข้อมูลครบ: พยากรณ์ ปิดยอด ซัพพลายเออร์',
    offerButton: 'เริ่มทัวร์',
    preparing: 'กำลังเตรียมร้านตัวอย่าง…',
    failed: 'เตรียมร้านตัวอย่างไม่ได้ โปรดลองอีกครั้ง',
    settings: 'เริ่มทัวร์',
    narration: 'อ่านออกเสียง',
    next: 'ถัดไป',
    back: 'ย้อนกลับ',
    skip: 'ข้าม',
    stepOf: '{n} จาก {total}',
    steps: [
      {
        title: 'ร้านของคุณในภาพรวม',
        body: 'นี่คือร้านตัวอย่างที่มียอดขายหกสัปดาห์ ทุกอย่างอัปเดตเมื่อคุณคุยกับผู้ช่วย',
      },
      { title: 'เมนูแยกตามหมวด', body: 'แตะราคาเพื่อแก้ไข สินค้าหมดจะแสดงบนหน้าลูกค้าทันที' },
      { title: 'แผนเตรียมของพรุ่งนี้', body: 'พยากรณ์จากยอดขาย ทำพอดีและเหลือทิ้งน้อยลง' },
      {
        title: 'ปิดยอดในหนึ่งนาที',
        body: 'ทุกเย็นถ่ายรูปรายงานแคชเชียร์ ของเข้า และสต็อก Chalkboard อ่านให้ คุณตรวจครั้งเดียว',
      },
      {
        title: 'ของใกล้หมด? หาซัพพลายเออร์',
        body: 'บอกผู้ช่วยว่า “แป้งใกล้หมด” ระบบจะหาซัพพลายเออร์ใกล้ๆ และคุณสั่งในแชทได้เลย',
      },
      {
        title: 'พูดหรือพิมพ์ก็ได้',
        body: '“ชาเย็นตอนนี้ 40 บาท ข้าวเหนียวมะม่วงหมด” ไม่มีอะไรเปลี่ยนจนกว่าคุณจะยืนยัน',
      },
      {
        title: 'ขึ้น Google แบบมีคนนำทาง',
        body: 'ข้อมูลและรูปของคุณกลายเป็นโปรไฟล์ Google ที่พร้อมใช้',
      },
      { title: 'แชร์หน้าร้าน', body: 'ลูกค้าสแกน QR เพื่อดูเมนูวันนี้ ถามคำถาม และสะสมแสตมป์' },
    ],
    doneTitle: 'พร้อมแล้ว',
    doneBody: 'สำรวจร้านตัวอย่างได้ตามใจ หรือเปิดร้านของคุณเองในหนึ่งนาที',
    startMine: 'เปิดร้านของฉัน',
    keepExploring: 'สำรวจต่อ',
  },
  vi: {
    offerTitle: 'Xem cách hoạt động trước',
    offerBody: 'Tham quan một phút cửa hàng mẫu đã có dữ liệu: dự báo, chốt ngày, nhà cung cấp.',
    offerButton: 'Bắt đầu tham quan',
    preparing: 'Đang chuẩn bị cửa hàng mẫu…',
    failed: 'Không chuẩn bị được cửa hàng mẫu. Vui lòng thử lại.',
    settings: 'Bắt đầu tham quan',
    narration: 'Đọc thành tiếng',
    next: 'Tiếp',
    back: 'Quay lại',
    skip: 'Bỏ qua',
    stepOf: '{n} / {total}',
    steps: [
      {
        title: 'Cửa hàng của bạn trong nháy mắt',
        body: 'Đây là cửa hàng mẫu với doanh thu sáu tuần. Mọi thứ cập nhật khi bạn trò chuyện với trợ lý.',
      },
      {
        title: 'Thực đơn theo danh mục',
        body: 'Chạm vào giá để đổi. Món hết hàng hiện ngay trên trang khách hàng.',
      },
      {
        title: 'Kế hoạch chuẩn bị ngày mai',
        body: 'Dự báo từ doanh thu của bạn, làm đủ mà ít lãng phí.',
      },
      {
        title: 'Chốt ngày trong một phút',
        body: 'Mỗi tối, chụp báo cáo quầy, hàng nhập và tồn kho. Chalkboard đọc giúp; bạn kiểm tra một lần.',
      },
      {
        title: 'Sắp hết? Tìm nhà cung cấp',
        body: 'Nói với trợ lý “bột mì sắp hết”. Trợ lý tìm nhà cung cấp gần đó và bạn đặt hàng ngay trong chat.',
      },
      {
        title: 'Chỉ cần nói hoặc gõ',
        body: '“Cà phê sữa giờ 25 nghìn, bánh mì hết rồi.” Không gì thay đổi cho đến khi bạn xác nhận.',
      },
      {
        title: 'Lên Google, có hướng dẫn',
        body: 'Thông tin và ảnh của bạn trở thành hồ sơ Google sẵn sàng.',
      },
      {
        title: 'Chia sẻ trang của bạn',
        body: 'Khách quét mã QR để xem thực đơn hôm nay, đặt câu hỏi và tích tem.',
      },
    ],
    doneTitle: 'Bạn đã sẵn sàng',
    doneBody:
      'Khám phá cửa hàng mẫu bao lâu tùy thích, hoặc tạo cửa hàng của riêng bạn trong một phút.',
    startMine: 'Mở cửa hàng của tôi',
    keepExploring: 'Tiếp tục khám phá',
  },
  fil: {
    offerTitle: 'Tingnan muna kung paano ito gumagana',
    offerBody:
      'Isang minutong tour sa demo na tindahang may laman: forecast, pagsasara ng araw, mga supplier.',
    offerButton: 'Simulan ang tour',
    preparing: 'Inihahanda ang iyong demo na tindahan…',
    failed: 'Hindi maihanda ang demo na tindahan. Pakisubukang muli.',
    settings: 'Simulan ang tour',
    narration: 'Basahin nang malakas',
    next: 'Susunod',
    back: 'Bumalik',
    skip: 'Laktawan',
    stepOf: '{n} sa {total}',
    steps: [
      {
        title: 'Ang tindahan mo sa isang tingin',
        body: 'Demo na tindahan ito na may anim na linggong benta. Nag-a-update ang lahat habang kausap mo ang coach.',
      },
      {
        title: 'Ang menu mo, ayon sa kategorya',
        body: 'I-tap ang presyo para baguhin. Agad lumalabas sa customer page ang mga ubos na.',
      },
      {
        title: 'Prep plan para bukas',
        body: 'Forecast mula sa benta mo, para sakto ang gawa at kaunti ang sayang.',
      },
      {
        title: 'Isara ang araw sa isang minuto',
        body: 'Tuwing gabi, kunan ang ulat ng kaha, delivery at stock. Binabasa ito ng Chalkboard; isang beses mo lang susuriin.',
      },
      {
        title: 'Paubos na? Maghanap ng supplier',
        body: 'Sabihin sa coach “paubos na ang harina ko”. Hahanap ito ng malapit na supplier at oorder ka sa chat.',
      },
      {
        title: 'Magsalita o mag-type lang',
        body: '“Kape ay ₱60 na, ubos na ang pandesal.” Walang magbabago hangga’t hindi mo kinukumpirma.',
      },
      {
        title: 'Pumunta sa Google, may gabay',
        body: 'Ang iyong mga detalye at litrato ay nagiging handang Google profile.',
      },
      {
        title: 'I-share ang page mo',
        body: 'Ini-scan ng customer ang QR mo para makita ang menu ngayon, magtanong at mangolekta ng stamp.',
      },
    ],
    doneTitle: 'Handa ka na',
    doneBody:
      'Galugarin ang demo na tindahan hangga’t gusto mo, o mag-set up ng sarili mong tindahan sa isang minuto.',
    startMine: 'Simulan ang tindahan ko',
    keepExploring: 'Patuloy na galugarin',
  },
}
