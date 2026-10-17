import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Collapse,
  IconButton,
  List,
  ListItem,
  ListItemText,
  Stack,
  Typography,
  useTheme,
} from '@mui/material'
import { ArrowLeft, ChevronDown, Leaf, MapPin, MessageCircle, Phone, RefreshCw } from 'lucide-react'
import { customerBack, customerNavigate } from '../frontdoors/navigation'
import type { ReactNode } from 'react'
import { type Locale } from '../../i18n/locales'
import { useLocale } from '../../state/hooks'
import { ShopSkeleton } from '../customer/Skeletons'
import { PlaceImage } from '../frontdoors/PlaceImage'
import { AppearanceToggle } from '../frontdoors/AppearanceToggle'
import { LanguagePicker } from '../frontdoors/LanguagePicker'
import { discoverCopy } from '../discover/strings'
import { loadScriptFont } from '../../i18n/fonts'
import { formatPrice } from '../v1/format'
import { factName } from '../v1/factNames'
import { Sheet } from '../v1/Sheet'
import type { ShopFacts } from '../v1/api'
import { en as ownerEnglish } from '../v1/strings'
import { translations as ownerTranslations } from '../v1/locales'
import { HAND_FONT, shape } from '../../design/theme'
import { chalkDust } from '../../design/chalkboard'
import { chalkWrite } from '../../design/chalkMotion'
import { ShopChat } from './ShopChat'
import { recsEvent } from '../recs/events'
import { useOnboardingCopy } from '../v1/onboardingCopy'
import { FollowButton } from '../customer/FollowButton'
import { Tips } from '../customer/Tips'
import { customerEnglish, whatsappUrl, type CustomerCopy } from './customerCopy'
import { customerTranslations } from './customerLocales'
import { BackInStock, BadgeRow, StampCard, StockReminder } from '../rewards/Rewards'
import { StampPeek } from '../rewards/StampCard'
import { ShopGames } from '../passport/games/ShopGames'
import { ShopStamp } from '../passport/ShopStamp'
import { HoursList } from '../shop/Hours'
import type { DayHours } from '../shop/hoursModel'
import { CategoryGroups } from '../shop/CategoryGroups'
import { useShopCopy } from '../shop/strings'
import { VerifiedBadge } from '../trust/VerifiedBadge'
import { unitLabel } from '../shop/units'
import { rememberOpened } from '../discover/opened'
import { SimilarNearby } from '../discover/SimilarNearby'
import { shopRegion, shopZone } from '../../region/region'

interface PublicShopData {
  id: string
  gallery?: string[]
  icon?: string | null
  last_confirmed?: string | null
  timezone?: string
  name: string
  category: string
  location: string
  hours: string
  weekly_hours?: DayHours[]
  phone: string
  reward_text?: string
  stamps_needed?: number
  stamps_enabled?: boolean
  /** ISO 4217 code the shop's prices are stored in. */
  currency?: string
  products: {
    name: string
    /** The item name in the customer's language; the owner's own name stays the title. */
    name_local?: string
    price: number
    unit: string
    available: boolean
    category?: string
  }[]
  /** Owner-confirmed customer facts; absent keys are simply not listed. */
  facts?: ShopFacts
  open_now?: boolean | null
  /** A seeded sample shop; always labelled "Demo shop". */
  demo?: boolean
  /** The owner passed the optional live face check (when; never who). */
  verified_owner?: { checked?: number | null }
}

function safePublicShop(value: unknown): PublicShopData {
  const data = value && typeof value === 'object' ? (value as Partial<PublicShopData>) : {}
  const products = Array.isArray(data.products)
    ? data.products
        .filter(
          (item): item is PublicShopData['products'][number] =>
            !!item &&
            typeof item.name === 'string' &&
            typeof item.unit === 'string' &&
            typeof item.price === 'number' &&
            typeof item.available === 'boolean',
        )
        .map((item) => ({
          ...item,
          name_local: typeof item.name_local === 'string' ? item.name_local : undefined,
          category: typeof item.category === 'string' ? item.category : undefined,
        }))
    : []
  const rawFacts = data.facts && typeof data.facts === 'object' ? data.facts : {}
  const facts: ShopFacts = {
    ...rawFacts,
    delivery_note: typeof rawFacts.delivery_note === 'string' ? rawFacts.delivery_note : undefined,
    preorder_lead_time:
      typeof rawFacts.preorder_lead_time === 'string' ? rawFacts.preorder_lead_time : undefined,
    busy_hours: typeof rawFacts.busy_hours === 'string' ? rawFacts.busy_hours : undefined,
    payment_methods: Array.isArray(rawFacts.payment_methods)
      ? rawFacts.payment_methods.filter((method): method is string => typeof method === 'string')
      : [],
    custom_facts: Array.isArray(rawFacts.custom_facts)
      ? rawFacts.custom_facts.filter(
          (fact) =>
            fact &&
            typeof fact.key === 'string' &&
            typeof fact.label === 'string' &&
            typeof fact.value === 'string',
        )
      : [],
  }
  return {
    ...data,
    id: typeof data.id === 'string' ? data.id : '',
    name: typeof data.name === 'string' ? data.name : '',
    category: typeof data.category === 'string' ? data.category : '',
    location: typeof data.location === 'string' ? data.location : '',
    hours: typeof data.hours === 'string' ? data.hours : '',
    phone: typeof data.phone === 'string' ? data.phone : '',
    products,
    gallery: Array.isArray(data.gallery)
      ? data.gallery.filter((item): item is string => typeof item === 'string')
      : [],
    weekly_hours: Array.isArray(data.weekly_hours) ? data.weekly_hours : [],
    facts,
  }
}

const PAYMENT_BRANDS = { paynow: 'PayNow', grabpay: 'GrabPay', nets: 'NETS' } as const
const DELIVERY_BRANDS = { grab: 'GrabFood', foodpanda: 'foodpanda' } as const

/** Small, plain chips for what customers ask most (halal, payment, delivery…). */
function factChips(facts: ShopFacts, t: CustomerCopy): string[] {
  const chips: string[] = []
  if (facts.halal === 'yes') chips.push(t.factHalal)
  if (facts.halal === 'muslim_owned') chips.push(t.factMuslimOwned)
  if (facts.halal === 'no') chips.push(t.factNotHalal)
  if (facts.vegetarian_options) chips.push(t.factVegetarian)
  if (facts.locally_made) chips.push(t.factLocallyMade)
  if (facts.delivery === 'none') chips.push(t.factNoDelivery)
  else if (facts.delivery === 'own' || facts.delivery === 'other') chips.push(t.factDelivery)
  else if (facts.delivery)
    chips.push(t.factDeliveryVia.replace('{name}', factName(facts.delivery, DELIVERY_BRANDS)))
  if (facts.preorders)
    chips.push(
      facts.preorder_lead_time
        ? t.factPreordersLead.replace('{lead}', facts.preorder_lead_time)
        : t.factPreorders,
    )
  for (const method of facts.payment_methods ?? [])
    chips.push(
      method === 'cash'
        ? t.factCash
        : method === 'card'
          ? t.factCard
          : method === 'other'
            ? t.factOtherPayment
            : factName(method, PAYMENT_BRANDS),
    )
  if (facts.busy_hours) chips.push(t.factBusy.replace('{hours}', facts.busy_hours))
  return chips
}

/** English source; customer-page translations override keys (missing keys fall back). */
const en = {
  ...customerEnglish,
  menu: 'Menu & prices',
  soldOut: 'Sold out',
  available: 'Available',
  directions: 'Directions',
  call: 'Call',
  refresh: 'Refresh',
  updated: 'Updated just now',
  missing: 'This shop page isn’t available.',
  missingBody: 'The owner may have stopped sharing it.',
  footer:
    'Prepared by the shop owner with Chalkboard · independent prototype, not a Google product',
  loading: 'Loading shop…',
  empty: 'The owner hasn’t added prices yet.',
  error: 'We couldn’t load this shop right now.',
  errorBody: 'Check your connection and try again.',
  retry: 'Try again',
  stale: 'Couldn’t refresh — showing the last menu we loaded.',
}

/** Native customer-page translations per locale (filled per language; English fallback). */
// Customer Q&A/contact keys come from customerLocales.ts.
const publicTranslations: Record<Locale, Omit<typeof en, keyof CustomerCopy>> = {
  hi: {
    menu: 'मेन्यू और दाम',
    soldOut: 'खत्म',
    available: 'उपलब्ध',
    directions: 'रास्ता',
    call: 'कॉल करें',
    refresh: 'ताज़ा करें',
    updated: 'अभी अपडेट हुआ',
    missing: 'दुकान का पेज उपलब्ध नहीं है।',
    missingBody: 'मालिक ने शेयर करना बंद किया होगा।',
    footer: 'मालिक ने Chalkboard से तैयार किया · स्वतंत्र नमूना, Google का उत्पाद नहीं',
    loading: 'दुकान लोड हो रही है…',
    empty: 'मालिक ने अभी दाम नहीं जोड़े हैं।',
    error: 'अभी दुकान लोड नहीं कर पाए।',
    errorBody: 'कनेक्शन जाँचकर फिर कोशिश करें।',
    retry: 'फिर कोशिश करें',
    stale: 'ताज़ा नहीं हुआ — पिछला लोड किया मेन्यू दिख रहा है।',
  },
  bn: {
    menu: 'মেনু ও দাম',
    soldOut: 'ফুরিয়েছে',
    available: 'পাওয়া যাচ্ছে',
    directions: 'পথনির্দেশ',
    call: 'কল করুন',
    refresh: 'রিফ্রেশ করুন',
    updated: 'এইমাত্র আপডেট হয়েছে',
    missing: 'দোকানের পেজ পাওয়া যাচ্ছে না।',
    missingBody: 'মালিক হয়তো শেয়ার বন্ধ করেছেন।',
    footer: 'মালিক Chalkboard দিয়ে তৈরি করেছেন · স্বাধীন নমুনা, Google-এর পণ্য নয়',
    loading: 'দোকান লোড হচ্ছে…',
    empty: 'মালিক এখনও দাম যোগ করেননি।',
    error: 'এখন দোকান লোড করা যায়নি।',
    errorBody: 'সংযোগ দেখে আবার চেষ্টা করুন।',
    retry: 'আবার চেষ্টা করুন',
    stale: 'রিফ্রেশ হয়নি — আগের লোড করা মেনু দেখাচ্ছে।',
  },
  te: {
    menu: 'మెనూ, ధరలు',
    soldOut: 'అయిపోయింది',
    available: 'అందుబాటులో ఉంది',
    directions: 'దారి',
    call: 'కాల్ చేయండి',
    refresh: 'రిఫ్రెష్ చేయండి',
    updated: 'ఇప్పుడే నవీకరించారు',
    missing: 'ఈ దుకాణం పేజీ అందుబాటులో లేదు.',
    missingBody: 'యజమాని షేర్ చేయడం ఆపి ఉండవచ్చు.',
    footer: 'యజమాని Chalkboardతో సిద్ధం చేశారు · స్వతంత్ర నమూనా, Google ఉత్పత్తి కాదు',
    loading: 'దుకాణం లోడ్ అవుతోంది…',
    empty: 'యజమాని ఇంకా ధరలు జోడించలేదు.',
    error: 'ఇప్పుడు ఈ దుకాణం లోడ్ చేయలేకపోయాం.',
    errorBody: 'కనెక్షన్ చూసి మళ్లీ ప్రయత్నించండి.',
    retry: 'మళ్లీ ప్రయత్నించండి',
    stale: 'రిఫ్రెష్ కాలేదు — చివరిగా లోడ్ చేసిన మెనూ చూపిస్తున్నాం.',
  },
  mr: {
    menu: 'मेनू आणि दर',
    soldOut: 'संपले',
    available: 'उपलब्ध',
    directions: 'रस्ता',
    call: 'कॉल करा',
    refresh: 'रिफ्रेश करा',
    updated: 'आत्ताच अपडेट केले',
    missing: 'दुकानाचे पेज उपलब्ध नाही.',
    missingBody: 'मालकाने शेअर करणे बंद केले असेल.',
    footer: 'मालकाने Chalkboard ने तयार केले · स्वतंत्र नमुना, Google चे उत्पादन नाही',
    loading: 'दुकान लोड करत आहोत…',
    empty: 'मालकाने अजून दर जोडलेले नाहीत.',
    error: 'आत्ता दुकान लोड करता आले नाही.',
    errorBody: 'जोडणी तपासून पुन्हा प्रयत्न करा.',
    retry: 'पुन्हा प्रयत्न करा',
    stale: 'रिफ्रेश झाले नाही — आधी लोड केलेला मेनू दिसत आहे.',
  },
  kn: {
    menu: 'ಮೆನು ಮತ್ತು ಬೆಲೆಗಳು',
    soldOut: 'ಮುಗಿದಿದೆ',
    available: 'ಲಭ್ಯ',
    directions: 'ದಾರಿ',
    call: 'ಕರೆ ಮಾಡಿ',
    refresh: 'ರಿಫ್ರೆಶ್ ಮಾಡಿ',
    updated: 'ಈಗಷ್ಟೇ ನವೀಕರಿಸಲಾಗಿದೆ',
    missing: 'ಈ ಅಂಗಡಿ ಪೇಜ್ ಲಭ್ಯವಿಲ್ಲ.',
    missingBody: 'ಮಾಲೀಕರು ಹಂಚುವುದನ್ನು ನಿಲ್ಲಿಸಿರಬಹುದು.',
    footer: 'ಮಾಲೀಕರು Chalkboard ಮೂಲಕ ಸಿದ್ಧಪಡಿಸಿದ್ದಾರೆ · ಸ್ವತಂತ್ರ ಮಾದರಿ, Google ಉತ್ಪನ್ನವಲ್ಲ',
    loading: 'ಅಂಗಡಿ ಲೋಡ್ ಆಗುತ್ತಿದೆ…',
    empty: 'ಮಾಲೀಕರು ಇನ್ನೂ ಬೆಲೆ ಸೇರಿಸಿಲ್ಲ.',
    error: 'ಈಗ ಅಂಗಡಿ ಲೋಡ್ ಮಾಡಲಾಗಲಿಲ್ಲ.',
    errorBody: 'ಸಂಪರ್ಕ ಪರಿಶೀಲಿಸಿ ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಿ.',
    retry: 'ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಿ',
    stale: 'ರಿಫ್ರೆಶ್ ಆಗಲಿಲ್ಲ — ಕೊನೆಯದಾಗಿ ಲೋಡ್ ಮಾಡಿದ ಮೆನು ತೋರಿಸುತ್ತಿದೆ.',
  },

  en,
  'zh-Hans': {
    menu: '菜单与价格',
    soldOut: '售罄',
    available: '有货',
    directions: '路线',
    call: '致电',
    refresh: '刷新',
    updated: '刚刚更新',
    missing: '此店铺页面无法访问。',
    missingBody: '店主可能已停止分享。',
    footer: '店主使用 Chalkboard 准备 · 独立原型，非 Google 产品',
    loading: '正在加载店铺…',
    empty: '店主尚未添加价格。',
    error: '暂时无法加载店铺。',
    errorBody: '请检查网络后重试。',
    retry: '重试',
    stale: '刷新失败，显示上次加载的菜单。',
  },
  ms: {
    menu: 'Menu & harga',
    soldOut: 'Habis',
    available: 'Tersedia',
    directions: 'Arah',
    call: 'Telefon',
    refresh: 'Muat semula',
    updated: 'Baru dikemas kini',
    missing: 'Halaman kedai ini tidak tersedia.',
    missingBody: 'Pemilik mungkin berhenti berkongsi.',
    footer: 'Disediakan pemilik dengan Chalkboard · prototaip bebas, bukan produk Google',
    loading: 'Memuatkan kedai…',
    empty: 'Pemilik belum tambah harga.',
    error: 'Kedai tidak dapat dimuatkan sekarang.',
    errorBody: 'Semak sambungan dan cuba lagi.',
    retry: 'Cuba lagi',
    stale: 'Gagal muat semula — menu terakhir dipaparkan.',
  },
  ta: {
    menu: 'உணவுப் பட்டியலும் விலைகளும்',
    soldOut: 'விற்றுத் தீர்ந்தது',
    available: 'கிடைக்கும்',
    directions: 'வழி',
    call: 'அழைக்கவும்',
    refresh: 'புதுப்பிக்கவும்',
    updated: 'இப்போதுதான் புதுப்பிக்கப்பட்டது',
    missing: 'இந்தக் கடைப் பக்கம் கிடைக்கவில்லை.',
    missingBody: 'உரிமையாளர் பகிர்வை நிறுத்தியிருக்கலாம்.',
    footer:
      'Chalkboard மூலம் கடை உரிமையாளர் தயாரித்தது · சுயாதீன முன்மாதிரி, Google தயாரிப்பு அல்ல',
    loading: 'கடையை ஏற்றுகிறோம்…',
    empty: 'உரிமையாளர் இன்னும் விலைகளைச் சேர்க்கவில்லை.',
    error: 'இப்போது கடையை ஏற்ற முடியவில்லை.',
    errorBody: 'இணைப்பைச் சரிபார்த்து மீண்டும் முயலுங்கள்.',
    retry: 'மீண்டும் முயலுங்கள்',
    stale: 'புதுப்பிக்க முடியவில்லை — முன்பு ஏற்றிய உணவுப் பட்டியலைக் காட்டுகிறோம்.',
  },
  ja: {
    menu: 'メニューと価格',
    soldOut: '売り切れ',
    available: '販売中',
    directions: '道案内',
    call: '電話する',
    refresh: '更新',
    updated: 'たった今更新',
    missing: 'このお店のページは利用できません。',
    missingBody: 'オーナーが共有を停止した可能性があります。',
    footer: 'オーナーが Chalkboard で作成・独立した試作アプリであり Google 製品ではありません',
    loading: 'お店を読み込んでいます…',
    empty: '価格はまだ追加されていません。',
    error: '今はお店を読み込めません。',
    errorBody: '接続を確認して再試行してください。',
    retry: '再試行',
    stale: '更新できませんでした。前回のメニューを表示しています。',
  },
  ko: {
    menu: '메뉴와 가격',
    soldOut: '품절',
    available: '판매 중',
    directions: '길찾기',
    call: '전화',
    refresh: '새로고침',
    updated: '방금 업데이트했어요',
    missing: '이 가게 페이지를 볼 수 없어요.',
    missingBody: '점주가 공유를 중단했을 수 있어요.',
    footer: '점주가 Chalkboard로 작성 · 독립 시제품이며 Google 제품이 아니에요',
    loading: '가게를 불러오고 있어요…',
    empty: '점주가 아직 가격을 추가하지 않았어요.',
    error: '지금 가게를 불러올 수 없어요.',
    errorBody: '연결을 확인하고 다시 시도해 주세요.',
    retry: '다시 시도',
    stale: '새로고침하지 못해 마지막으로 불러온 메뉴를 보여 드려요.',
  },
  id: {
    menu: 'Menu & harga',
    soldOut: 'Habis',
    available: 'Tersedia',
    directions: 'Rute',
    call: 'Telepon',
    refresh: 'Muat ulang',
    updated: 'Baru diperbarui',
    missing: 'Halaman toko ini tidak tersedia.',
    missingBody: 'Pemilik mungkin menghentikan berbagi.',
    footer: 'Disiapkan pemilik dengan Chalkboard · prototipe independen, bukan produk Google',
    loading: 'Memuat toko…',
    empty: 'Pemilik belum menambahkan harga.',
    error: 'Toko belum dapat dimuat saat ini.',
    errorBody: 'Periksa koneksi dan coba lagi.',
    retry: 'Coba lagi',
    stale: 'Gagal memuat ulang — menampilkan menu terakhir.',
  },
  th: {
    menu: 'เมนูและราคา',
    soldOut: 'หมดแล้ว',
    available: 'มีสินค้า',
    directions: 'เส้นทาง',
    call: 'โทร',
    refresh: 'รีเฟรช',
    updated: 'เพิ่งอัปเดต',
    missing: 'ไม่พบหน้าร้านนี้',
    missingBody: 'เจ้าของอาจหยุดแชร์แล้ว',
    footer: 'เจ้าของจัดทำด้วย Chalkboard · แอปต้นแบบอิสระ ไม่ใช่ผลิตภัณฑ์ Google',
    loading: 'กำลังโหลดร้าน…',
    empty: 'เจ้าของยังไม่เพิ่มราคา',
    error: 'ตอนนี้โหลดร้านไม่ได้',
    errorBody: 'ตรวจการเชื่อมต่อแล้วลองอีกครั้ง',
    retry: 'ลองอีกครั้ง',
    stale: 'รีเฟรชไม่ได้ แสดงเมนูที่โหลดครั้งล่าสุด',
  },
  vi: {
    menu: 'Thực đơn và giá',
    soldOut: 'Hết hàng',
    available: 'Còn bán',
    directions: 'Đường đi',
    call: 'Gọi',
    refresh: 'Làm mới',
    updated: 'Vừa cập nhật',
    missing: 'Trang cửa hàng này không khả dụng.',
    missingBody: 'Chủ cửa hàng có thể đã ngừng chia sẻ.',
    footer:
      'Chủ cửa hàng chuẩn bị bằng Chalkboard · bản thử nghiệm độc lập, không phải sản phẩm Google',
    loading: 'Đang tải cửa hàng…',
    empty: 'Chủ cửa hàng chưa thêm giá.',
    error: 'Hiện chưa tải được cửa hàng.',
    errorBody: 'Kiểm tra kết nối và thử lại.',
    retry: 'Thử lại',
    stale: 'Không làm mới được — đang hiển thị thực đơn đã tải lần trước.',
  },
  fil: {
    menu: 'Menu at presyo',
    soldOut: 'Ubos na',
    available: 'May stock',
    directions: 'Direksyon',
    call: 'Tumawag',
    refresh: 'I-refresh',
    updated: 'Kaka-update lang',
    missing: 'Hindi available ang pahina ng tindahan.',
    missingBody: 'Maaaring itinigil ng may-ari ang pag-share.',
    footer:
      'Inihanda ng may-ari gamit ang Chalkboard · hiwalay na prototype, hindi produkto ng Google',
    loading: 'Nilo-load ang tindahan…',
    empty: 'Wala pang inilalagay na presyo ang may-ari.',
    error: 'Hindi ma-load ang tindahan ngayon.',
    errorBody: 'Suriin ang koneksyon at subukan muli.',
    retry: 'Subukan muli',
    stale: 'Hindi ma-refresh — ipinapakita ang huling na-load na menu.',
  },
}

/** Customer-facing, read-only page for a shop the owner chose to share. No sign-in. */
export default function PublicShop({ id }: { id: string }) {
  const locale = useLocale()
  const shopCopy = useShopCopy()
  const o = useOnboardingCopy()
  const discovery = discoverCopy(locale)
  const freshnessCopy = locale === 'en' ? ownerEnglish : ownerTranslations[locale]
  const t = {
    ...en,
    ...publicTranslations[locale],
    ...(locale === 'en' ? {} : customerTranslations[locale]),
  }
  const theme = useTheme()
  const roles = theme.material
  // Controls over the photo: a frosted surface keeps them legible on any picture.
  const frosted = {
    bgcolor: `color-mix(in srgb, ${roles.surface} 78%, transparent)`,
    backdropFilter: 'blur(10px)',
    '&:hover': { bgcolor: roles.surface },
  }
  const [shop, setShop] = useState<PublicShopData | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'missing' | 'error'>('loading')
  // Data shown may be older than the last attempt when a refresh failed (network/server).
  const [stale, setStale] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [chatOpen, setChatOpen] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const previous = useRef<PublicShopData | null>(null)
  const [changedPrices, setChangedPrices] = useState<string[]>([])
  useEffect(() => {
    document.documentElement.lang = locale
    void loadScriptFont(locale)
  }, [locale])

  const fetchShop = useCallback(
    (signal?: AbortSignal) =>
      // Categories, sections and the demo story come back in the customer's language (English
      // is the source, so it needs no parameter).
      fetch(
        `/api/v1/public/shops/${encodeURIComponent(id)}${locale === 'en' ? '' : `?lang=${locale}`}`,
        { signal },
      ).then(async (response) => {
        // 404 = owner stopped sharing; anything else is a transient failure.
        if (response.status === 404) throw new Error('missing')
        if (!response.ok) throw new Error('error')
        return safePublicShop(await response.json())
      }),
    [id, locale],
  )
  const apply = useCallback((data: PublicShopData) => {
    const old = previous.current
    const changed = data.products.filter(
      (product) =>
        old?.id === data.id &&
        old.products.some(
          (before) =>
            before.name === product.name &&
            before.unit === product.unit &&
            before.price !== product.price,
        ),
    )
    if (changed.length) setChangedPrices(changed.map((product) => product.name + product.unit))
    previous.current = data
    // A personal signal for this person's own search and Today's 7, kept on this device.
    rememberOpened(data.id)
    setShop(data)
    setStale(false)
    setState('ready')
  }, [])
  const failRefresh = useCallback((error: unknown) => {
    if (error instanceof Error && error.message === 'missing') {
      setShop(null)
      setState('missing')
    } else setStale(true)
  }, [])
  useEffect(() => {
    const abort = new AbortController()
    void fetchShop(abort.signal)
      .then((data) => {
        if (abort.signal.aborted) return
        apply(data)
        document.title = `${data.name} · ${t.menu}`
        recsEvent({ kind: 'shop_open', shop_id: data.id })
      })
      .catch((error: unknown) => {
        if (!abort.signal.aborted)
          setState(error instanceof Error && error.message === 'missing' ? 'missing' : 'error')
      })
    return () => {
      abort.abort()
    }
  }, [fetchShop, t.menu, apply, failRefresh])
  useEffect(() => {
    let pending: AbortController | null = null
    const refresh = () => {
      if (document.visibilityState !== 'visible' || pending) return
      const abort = new AbortController()
      pending = abort
      void fetchShop(AbortSignal.any([abort.signal, AbortSignal.timeout(10_000)]))
        .then((data) => {
          if (!abort.signal.aborted) apply(data)
        })
        .catch((error: unknown) => {
          if (!abort.signal.aborted) failRefresh(error)
        })
        .finally(() => {
          if (pending === abort) pending = null
        })
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh()
      else {
        pending?.abort()
        pending = null
      }
    }
    const timer = window.setInterval(refresh, 4000)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.clearInterval(timer)
      pending?.abort()
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [fetchShop, apply, failRefresh])
  useEffect(() => {
    if (!changedPrices.length) return
    const timer = window.setTimeout(() => setChangedPrices([]), 1800)
    return () => window.clearTimeout(timer)
  }, [changedPrices])

  if (state === 'loading') return <ShopSkeleton />
  if (state === 'error')
    return (
      <Stack spacing={2} sx={{ maxWidth: 480, mx: 'auto', px: 3, pt: 12, textAlign: 'center' }}>
        <Typography component="h1" variant="headlineSmall">
          {t.error}
        </Typography>
        <Typography variant="bodyLarge" color="text.secondary">
          {t.errorBody}
        </Typography>
        <Button variant="contained" onClick={() => location.reload()} sx={{ alignSelf: 'center' }}>
          {t.retry}
        </Button>
      </Stack>
    )
  if (state === 'missing' || !shop)
    return (
      <Stack spacing={2} sx={{ maxWidth: 480, mx: 'auto', px: 3, pt: 12, textAlign: 'center' }}>
        <Typography component="h1" variant="headlineSmall">
          {t.missing}
        </Typography>
        <Typography variant="bodyLarge" color="text.secondary">
          {t.missingBody}
        </Typography>
        <Button
          component="a"
          href="/explore/"
          onClick={customerNavigate}
          variant="contained"
          startIcon={<ArrowLeft size={20} />}
          sx={{ alignSelf: 'center' }}
        >
          {t.back}
        </Button>
      </Stack>
    )

  const currency = shop.currency ?? shopRegion(shop).currency
  // The public API names owner-written facts `custom` (owner records use `custom_facts`).
  const customValue =
    (shop.facts as (ShopFacts & { custom?: ShopFacts['custom_facts'] }) | undefined)?.custom ??
    shop.facts?.custom_facts ??
    []
  const custom = Array.isArray(customValue)
    ? customValue.filter(
        (fact) =>
          fact &&
          typeof fact.key === 'string' &&
          typeof fact.label === 'string' &&
          typeof fact.value === 'string',
      )
    : []
  const chips = [
    ...factChips(shop.facts ?? {}, t),
    // Type-specific facts the owner confirmed (e.g. a salon's walk-ins), label: value.
    ...custom
      // The story has its own line; the demo label is already in the header.
      .filter((fact) => fact.key !== 'story' && fact.key !== 'demo_data')
      .map((fact) => `${fact.label}: ${fact.value}`),
  ]
  // Available items first; sold-out items stay listed (customers ask about them) but last.
  const story = custom.find((fact) => fact.key === 'story')?.value
  const menu = [...shop.products].sort((a, b) => Number(b.available) - Number(a.available))
  const openLabel = shop.open_now == null ? null : shop.open_now ? discovery.open : discovery.closed
  const stampsEnabled = shop.stamps_enabled ?? Boolean(shop.reward_text?.trim())
  // Demo shops' numbers are fictional; never offer to call or message them.
  const phone = shop.demo ? '' : shop.phone
  const actions = [
    shop.location && {
      label: t.directions,
      icon: <MapPin size={20} />,
      href:
        'https://www.google.com/maps/search/?api=1&query=' +
        encodeURIComponent(`${shop.name} ${shop.location}`),
    },
    phone && {
      label: t.call,
      icon: <Phone size={20} />,
      href: `tel:${phone.replace(/[^\d+]/g, '')}`,
    },
    phone && {
      label: t.whatsapp,
      icon: <MessageCircle size={20} />,
      href: whatsappUrl(phone, shop.name, t.whatsappMessage),
    },
  ].filter(Boolean) as { label: string; icon: ReactNode; href: string }[]

  return (
    <Box
      component="main"
      sx={{
        maxWidth: 720,
        mx: 'auto',
        px: 4,
        // Phones: the photo runs to the screen's top edge, under the status bar.
        pt: { xs: 0, sm: 'calc(16px + env(safe-area-inset-top))' },
        // Room for the pinned chat bar (prevents occlusion at 200% font zoom).
        pb: 'calc(148px + env(safe-area-inset-bottom))',
      }}
    >
      {/* Back and controls: on phones they float over the photo in frosted circles and stay
          pinned while the page scrolls, so Back is always one thumb away. 48px targets. */}
      <Stack
        direction="row"
        sx={{
          position: 'sticky',
          top: 0,
          zIndex: 10,
          alignItems: 'center',
          justifyContent: 'space-between',
          minHeight: 64,
          mx: { xs: -2, sm: 0 },
          pt: { xs: 'env(safe-area-inset-top, 0px)', sm: 0 },
          mb: { xs: 'calc(-64px - env(safe-area-inset-top, 0px))', sm: 2 },
          pointerEvents: 'none',
          '& > *': { pointerEvents: 'auto' },
        }}
      >
        <IconButton
          component="a"
          href="/explore/"
          onClick={customerBack}
          aria-label={t.back}
          sx={{ width: 48, height: 48, flexShrink: 0, ...frosted }}
        >
          <ArrowLeft size={20} />
        </IconButton>
        <Stack
          direction="row"
          spacing={0.5}
          sx={{ alignItems: 'center', flexShrink: 0, borderRadius: 999, ...frosted }}
        >
          <LanguagePicker variant="inline" />
          <AppearanceToggle inline />
        </Stack>
      </Stack>

      {/* Hero photo / artwork banner with fixed aspect ratio + object-fit */}
      <Box
        data-testid="shop-hero-banner"
        sx={{
          // Full-bleed on phones: the shop's photo is the first thing you see.
          width: { xs: 'calc(100% + 32px)', sm: '100%' },
          mx: { xs: -4, sm: 0 },
          aspectRatio: '16/10',
          maxHeight: { xs: 300, sm: 260 },
          borderRadius: { xs: 0, sm: `${shape.xl}px` },
          overflow: 'hidden',
          bgcolor: roles.surfaceContainerHigh,
          position: 'relative',
          '& > div': { height: '100%' },
          '& img': { height: '100%', width: '100%', objectFit: 'cover' },
        }}
      >
        <PlaceImage
          id={id}
          category={shop.category}
          photo={
            shop.gallery?.[0]
              ? `/api/v1/public/shops/${id}/photos/${shop.gallery[0]}.jpg`
              : shop.icon
                ? `/api/v1/public/shops/${id}/icon/${shop.icon}.jpg`
                : undefined
          }
          eager
          transition
          compact
        />
      </Box>

      {/* Prominent Shop Name (full width, unclipped in English, Hindi and Tamil). On phones the
          page rises over the photo's lower edge like a sheet. */}
      <Box
        sx={{
          position: 'relative',
          minWidth: 0,
          mt: { xs: -3, sm: 3 },
          mx: { xs: -4, sm: 0 },
          px: { xs: 4, sm: 0 },
          pt: { xs: 3, sm: 0 },
          borderRadius: { xs: '28px 28px 0 0', sm: 0 },
          bgcolor: 'background.default',
          // The page's dark chalk grain, so the sheet reads as the page itself.
          backgroundImage: theme.palette.mode === 'dark' ? chalkDust : 'none',
        }}
      >
        <Typography
          component="h1"
          variant="headlineSmall"
          sx={{
            fontWeight: 700,
            overflowWrap: 'break-word',
            color: roles.onSurface,
            lineHeight: 1.2,
          }}
        >
          {shop.name}
        </Typography>

        <Stack
          direction="row"
          spacing={1.5}
          sx={{ alignItems: 'center', flexWrap: 'wrap', mt: 1.5 }}
        >
          {openLabel && (
            <Typography
              variant="labelLarge"
              sx={{
                color: roles.onSurface,
                fontWeight: 600,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 1,
              }}
            >
              <Box
                component="span"
                aria-hidden="true"
                sx={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  bgcolor: shop.open_now ? 'var(--customer-open)' : roles.outline,
                }}
              />
              {openLabel}
            </Typography>
          )}
          {[shop.category, shop.hours].filter(Boolean).map((text, index) => (
            <Typography
              key={text}
              variant="bodyMedium"
              color="text.secondary"
              sx={{ overflowWrap: 'break-word', minWidth: 0 }}
            >
              {openLabel || index > 0 ? `· ${text}` : text}
            </Typography>
          ))}
          {shop.verified_owner && !shop.demo && (
            <VerifiedBadge checked={shop.verified_owner.checked} />
          )}
          {shop.demo && (
            <Chip label={t.demoShop} size="small" variant="outlined" sx={{ height: 24 }} />
          )}
        </Stack>
      </Box>
      {/* One line a neighbour would say about the place, in chalk. */}
      {story && (
        <Typography
          sx={{
            ...chalkWrite,
            mt: 2,
            fontFamily: HAND_FONT,
            fontSize: '1.375rem',
            lineHeight: 1.25,
            fontWeight: 600,
            color: theme.chalk.sunflower.main,
          }}
        >
          “{story}”
        </Typography>
      )}
      {/* Sample shops say so in words, not only with a chip. */}
      {shop.demo && (
        <Typography variant="bodySmall" color="text.secondary" sx={{ mt: 2 }}>
          {t.demoShopNote}
        </Typography>
      )}
      {/* Follow, stamps and how to get there in one row the thumb can swipe, never a stack. */}
      <Stack
        direction="row"
        sx={{
          mt: 3,
          gap: 1.5,
          alignItems: 'center',
          overflowX: 'auto',
          scrollbarWidth: 'none',
          '&::-webkit-scrollbar': { display: 'none' },
          mx: -4,
          px: 4,
          py: 0.5,
          '& > *': { flexShrink: 0 },
        }}
      >
        <FollowButton id={id} name={shop.name} />
        {stampsEnabled && <StampPeek shop={id} needed={shop.stamps_needed ?? 8} />}
        {actions.map((action) => (
          <Button
            key={action.label}
            variant="outlined"
            size="small"
            startIcon={action.icon}
            href={action.href}
            target={action.href.startsWith('http') ? '_blank' : undefined}
            rel={action.href.startsWith('http') ? 'noopener noreferrer' : undefined}
            sx={{ minHeight: 48 }}
          >
            {action.label}
          </Button>
        ))}
      </Stack>
      {chips.length > 0 && (
        <Box
          component="ul"
          aria-label={t.factsLabel}
          // Chips wrap onto more lines: long Tamil/Kannada words never hide past the edge.
          sx={{
            listStyle: 'none',
            m: 0,
            p: 0,
            mt: 2,
            display: 'flex',
            flexWrap: 'wrap',
            gap: 1,
          }}
        >
          {chips.map((chip) => (
            <Box
              component="li"
              key={chip}
              sx={{
                minWidth: 0,
                maxWidth: '100%',
                px: 2,
                py: 1,
                borderRadius: `${shape.sm}px`,
                bgcolor: roles.secondaryContainer,
                color: roles.onSecondaryContainer,
                typography: 'labelLarge',
                overflowWrap: 'anywhere',
              }}
            >
              {chip}
            </Box>
          ))}
        </Box>
      )}
      {/* Hours and address on demand; freshness stays in view (trust). */}
      <Stack direction="row" sx={{ mt: 1, alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
        <Button
          variant="text"
          size="small"
          onClick={() => setDetailsOpen((open) => !open)}
          aria-expanded={detailsOpen}
          endIcon={
            <ChevronDown
              size={18}
              style={{
                transform: detailsOpen ? 'rotate(180deg)' : 'none',
                transition: 'transform 200ms ease',
              }}
            />
          }
          sx={{ px: 2, minHeight: 48, color: 'text.secondary', fontWeight: 500 }}
        >
          {shopCopy.weeklyHours}
          {shop.hours
            ? ` · ${shop.hours}`
            : !shop.weekly_hours?.length
              ? ` · ${o.hoursNotSet}`
              : ''}
        </Button>
        <Typography variant="bodySmall" color="text.secondary">
          {shop.last_confirmed
            ? (() => {
                // "Today" in the shop's own timezone, so a late-night check reads correctly.
                const parts = new Intl.DateTimeFormat('en-CA', {
                  timeZone: shopZone(shop),
                  year: 'numeric',
                  month: '2-digit',
                  day: '2-digit',
                }).formatToParts(new Date())
                const part = (name: string) => parts.find((p) => p.type === name)?.value
                const today = `${part('year')}-${part('month')}-${part('day')}`
                const days = Math.max(
                  0,
                  Math.round((Date.parse(today) - Date.parse(shop.last_confirmed)) / 86_400_000),
                )
                return days === 0 ? freshnessCopy.updatedToday : freshnessCopy.updatedDays(days)
              })()
            : freshnessCopy.menuUnconfirmed}
        </Typography>
      </Stack>
      <Collapse in={detailsOpen} unmountOnExit>
        <Box sx={{ mt: 1 }}>
          <HoursList hours={shop.weekly_hours} />
        </Box>
        {shop.location && (
          <Typography variant="bodySmall" color="text.secondary" sx={{ mt: 2 }}>
            {shop.location}
          </Typography>
        )}
      </Collapse>
      {/* Menu: dense, aligned prices, readable at a glance. */}
      <Stack
        direction="row"
        sx={{
          alignItems: 'center',
          mt: 3,
          py: 1,
          position: 'sticky',
          top: 'env(safe-area-inset-top)',
          zIndex: 1,
          bgcolor: 'background.default',
        }}
      >
        <Typography component="h2" variant="titleMedium" sx={{ flex: 1 }}>
          {t.menu}
          <Typography
            component="span"
            variant="bodyMedium"
            color="text.secondary"
            sx={{ whiteSpace: 'nowrap' }}
          >
            {' '}
            ·&nbsp;{shop.products.length}
          </Typography>
        </Typography>
        <IconButton
          aria-label={t.refresh}
          onClick={() => {
            setRefreshing(true)
            void fetchShop()
              .then(apply)
              .catch(failRefresh)
              .finally(() => setRefreshing(false))
          }}
        >
          {refreshing ? <CircularProgress size={18} /> : <RefreshCw size={18} />}
        </IconButton>
      </Stack>
      {stale && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          {t.stale}
        </Alert>
      )}
      {shop.products.length === 0 ? (
        // A new shop goes live before its menu (owner decision, 17 Oct): customers can already
        // talk to it.
        <Alert
          severity="info"
          data-testid="menu-coming-soon"
          action={
            <Button color="inherit" size="small" onClick={() => setChatOpen(true)}>
              {o.chatShop}
            </Button>
          }
        >
          {o.menuSoon}
        </Alert>
      ) : (
        <CategoryGroups products={shop.products}>
          {(items) => (
            <List
              disablePadding
              sx={{
                bgcolor: roles.surfaceContainerLow,
                borderRadius: `${shape.md}px`,
                border: `1px solid ${roles.outlineVariant}`,
              }}
            >
              {items.map((product, index) => (
                <ListItem
                  key={product.name + product.unit}
                  divider={index < items.length - 1}
                  sx={{ py: 2, px: 2, gap: 2 }}
                >
                  <ListItemText
                    primary={
                      product.name_local ? (
                        <>
                          {product.name}
                          {/* The owner's name stays; the customer's language is a subtitle. */}
                          <Typography
                            component="span"
                            variant="bodyMedium"
                            color="text.secondary"
                            sx={{ display: 'block' }}
                          >
                            {product.name_local}
                          </Typography>
                        </>
                      ) : (
                        product.name
                      )
                    }
                    secondary={
                      product.available ? (
                        `/ ${unitLabel(product.unit, shopCopy)}`
                      ) : (
                        <StockReminder shop={id} name={product.name} unit={product.unit} />
                      )
                    }
                    slotProps={{
                      primary: {
                        variant: 'bodyLarge',
                        sx: product.available ? undefined : { color: 'text.secondary' },
                      },
                      secondary: { variant: 'bodySmall', component: 'div' },
                    }}
                  />
                  {product.available ? (
                    <Typography
                      key={product.price}
                      data-price-changed={
                        changedPrices.includes(product.name + product.unit) || undefined
                      }
                      variant="titleMedium"
                      sx={{
                        whiteSpace: 'nowrap',
                        fontVariantNumeric: 'tabular-nums',
                        position: 'relative',
                        '&[data-price-changed]::before': {
                          content: '""',
                          position: 'absolute',
                          inset: -4,
                          borderRadius: 1,
                          bgcolor: roles.primaryContainer,
                          zIndex: -1,
                          animation: 'price-change 1.8s ease-out both',
                          '@media (prefers-reduced-motion: reduce)': {
                            animation: 'none',
                            opacity: 1,
                          },
                        },
                        isolation: 'isolate',
                        '@keyframes price-change': { from: { opacity: 1 }, to: { opacity: 0 } },
                      }}
                    >
                      {/* The phone's full locale (en-SG → $15.00), not just the UI language. */}
                      {formatPrice(product.price, currency)}
                    </Typography>
                  ) : (
                    // Sold out: label + muted text, not colour alone.
                    <Box
                      component="span"
                      sx={{
                        px: 1,
                        py: 0.25,
                        borderRadius: `${shape.xs}px`,
                        bgcolor: roles.errorContainer,
                        color: roles.onErrorContainer,
                        typography: 'labelMedium',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {t.soldOut}
                    </Box>
                  )}
                </ListItem>
              ))}
            </List>
          )}
        </CategoryGroups>
      )}
      {/* Rewards after the menu: earned, not in the way. */}
      {stampsEnabled && (
        <StampCard
          shop={id}
          name={shop.name}
          timezone={shopZone(shop)}
          reward={shop.reward_text}
          needed={shop.stamps_needed ?? 8}
        />
      )}
      {stampsEnabled && (
        <ShopStamp
          shop={{
            id,
            name: shop.name,
            category: shop.category,
            demo: shop.demo,
            timezone: shopZone(shop),
            needed: shop.stamps_needed ?? 8,
          }}
        />
      )}
      {stampsEnabled && <ShopGames shop={id} />}
      {!stale && <BackInStock shop={id} products={shop.products} />}
      {stampsEnabled && <BadgeRow shop={id} />}
      <Tips shop={id} />
      <SimilarNearby
        key={id}
        shop={id}
        items={menu.filter((product) => product.available).map((product) => product.name)}
      />
      <Stack
        direction="row"
        spacing={1}
        sx={{ mt: 3, alignItems: 'center', color: 'text.secondary', justifyContent: 'center' }}
      >
        <Leaf size={14} aria-hidden="true" />
        <Typography variant="bodySmall" sx={{ textAlign: 'center' }}>
          {t.footer}
        </Typography>
      </Stack>
      {/* One way to reach the shop: instant answers first, the owner when needed. */}
      <Box
        sx={{
          position: 'fixed',
          left: 0,
          right: 0,
          bottom: 0,
          px: 2,
          pt: 2,
          pb: 'calc(12px + env(safe-area-inset-bottom))',
          bgcolor: roles.surfaceContainer,
          borderTop: `1px solid ${roles.outlineVariant}`,
          zIndex: 2,
        }}
      >
        <Button
          fullWidth
          variant="contained"
          size="large"
          startIcon={<MessageCircle size={20} />}
          onClick={() => setChatOpen(true)}
          sx={{ maxWidth: 720, mx: 'auto', display: 'flex', minHeight: 52 }}
        >
          {t.chatTitle}
        </Button>
      </Box>
      <Sheet
        keepMounted
        open={chatOpen}
        onClose={() => setChatOpen(false)}
        titleId="shop-chat-title"
        title={t.chatTitle}
      >
        <Typography variant="bodyMedium" color="text.secondary">
          {t.chatIntro}
        </Typography>
        <ShopChat
          key={`chat-${id}`}
          id={id}
          facts={stale ? '' : JSON.stringify(shop)}
          item={menu[0]?.name}
          currency={currency}
          copy={t}
        />
      </Sheet>
    </Box>
  )
}
