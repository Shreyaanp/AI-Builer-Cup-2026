import { ConversationView } from './ConversationView'
import { conversationEnglish } from './conversationCopy'
import type { ConversationCopy, Translation } from './conversationCopy'
import { followInquiries } from '../../api/inquiryStream'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, Box, Button, CircularProgress, Divider, Stack, Typography } from '@mui/material'
import type { components } from '../../api/generated'
import type { Locale } from '../../i18n/locales'
import { useLocale } from '../../state/hooks'
import { useWorkspace } from '../v1/workspaceContext'
import type { TipList } from '../customer/types'
import { OwnerTips } from './OwnerTips'
import { useGuestCopy } from '../customer/guestCopy'

const en = {
  ...conversationEnglish,
  title: 'Messages',
  empty: 'No customer messages yet.',
  loading: 'Loading messages…',
  reload: 'Reload messages',
  failed: 'Could not load or update messages. Please try again.',
  unnamed: 'Customer',
}
const translations: Record<Exclude<Locale, 'en'>, Omit<typeof en, keyof ConversationCopy>> = {
  hi: {
    title: 'संदेश',
    empty: 'अभी ग्राहकों के संदेश नहीं हैं।',
    loading: 'संदेश लोड हो रहे हैं…',
    reload: 'संदेश फिर लोड करें',
    failed: 'संदेश लोड या अपडेट नहीं हुए। फिर कोशिश करें।',
    unnamed: 'ग्राहक',
  },
  bn: {
    title: 'বার্তাগুলি',
    empty: 'এখনও ক্রেতাদের বার্তা নেই।',
    loading: 'বার্তা লোড হচ্ছে…',
    reload: 'বার্তা আবার লোড করুন',
    failed: 'বার্তা লোড বা আপডেট হয়নি। আবার চেষ্টা করুন।',
    unnamed: 'ক্রেতা',
  },
  te: {
    title: 'సందేశాలు',
    empty: 'ఇంకా కస్టమర్ సందేశాలు లేవు.',
    loading: 'సందేశాలు లోడ్ అవుతున్నాయి…',
    reload: 'సందేశాలు మళ్లీ లోడ్ చేయండి',
    failed: 'సందేశాలు లోడ్ లేదా నవీకరణ కాలేదు. మళ్లీ ప్రయత్నించండి.',
    unnamed: 'కస్టమర్',
  },
  mr: {
    title: 'संदेश',
    empty: 'अजून ग्राहकांचे संदेश नाहीत.',
    loading: 'संदेश लोड करत आहोत…',
    reload: 'संदेश पुन्हा लोड करा',
    failed: 'संदेश लोड किंवा अपडेट झाले नाहीत. पुन्हा प्रयत्न करा.',
    unnamed: 'ग्राहक',
  },
  kn: {
    title: 'ಸಂದೇಶಗಳು',
    empty: 'ಇನ್ನೂ ಗ್ರಾಹಕರ ಸಂದೇಶಗಳಿಲ್ಲ.',
    loading: 'ಸಂದೇಶಗಳು ಲೋಡ್ ಆಗುತ್ತಿವೆ…',
    reload: 'ಸಂದೇಶ ಮತ್ತೆ ಲೋಡ್ ಮಾಡಿ',
    failed: 'ಸಂದೇಶ ಲೋಡ್ ಅಥವಾ ನವೀಕರಿಸಲಾಗಲಿಲ್ಲ. ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಿ.',
    unnamed: 'ಗ್ರಾಹಕ',
  },

  'zh-Hans': {
    title: '顾客留言',
    empty: '还没有顾客留言。',
    loading: '正在加载留言…',
    reload: '重新加载留言',
    failed: '无法加载或更新留言，请重试。',
    unnamed: '顾客',
  },
  ms: {
    title: 'Mesej',
    empty: 'Belum ada mesej pelanggan.',
    loading: 'Memuatkan mesej…',
    reload: 'Muat semula mesej',
    failed: 'Tidak dapat memuatkan atau mengemas kini mesej. Sila cuba lagi.',
    unnamed: 'Pelanggan',
  },
  ta: {
    title: 'செய்திகள்',
    empty: 'இன்னும் வாடிக்கையாளர் செய்திகள் இல்லை.',
    loading: 'செய்திகளை ஏற்றுகிறது…',
    reload: 'செய்திகளை மீண்டும் ஏற்று',
    failed: 'செய்திகளை ஏற்றவோ புதுப்பிக்கவோ முடியவில்லை. மீண்டும் முயலுங்கள்.',
    unnamed: 'வாடிக்கையாளர்',
  },
  ja: {
    title: 'メッセージ',
    empty: 'お客様からのメッセージはまだありません。',
    loading: 'メッセージを読み込んでいます…',
    reload: 'メッセージを再読み込み',
    failed: 'メッセージを読み込めないか、更新できませんでした。もう一度お試しください。',
    unnamed: 'お客様',
  },
  ko: {
    title: '메시지',
    empty: '아직 손님 메시지가 없어요.',
    loading: '메시지를 불러오는 중…',
    reload: '메시지 새로고침',
    failed: '메시지를 불러오거나 업데이트하지 못했어요. 다시 시도해 주세요.',
    unnamed: '손님',
  },
  id: {
    title: 'Pesan',
    empty: 'Belum ada pesan pelanggan.',
    loading: 'Memuat pesan…',
    reload: 'Muat ulang pesan',
    failed: 'Tidak dapat memuat atau memperbarui pesan. Silakan coba lagi.',
    unnamed: 'Pelanggan',
  },
  th: {
    title: 'ข้อความ',
    empty: 'ยังไม่มีข้อความจากลูกค้า',
    loading: 'กำลังโหลดข้อความ…',
    reload: 'โหลดข้อความใหม่',
    failed: 'โหลดหรืออัปเดตข้อความไม่สำเร็จ กรุณาลองใหม่',
    unnamed: 'ลูกค้า',
  },
  vi: {
    title: 'Tin nhắn',
    empty: 'Chưa có tin nhắn nào từ khách.',
    loading: 'Đang tải tin nhắn…',
    reload: 'Tải lại tin nhắn',
    failed: 'Không tải hoặc cập nhật được tin nhắn. Vui lòng thử lại.',
    unnamed: 'Khách hàng',
  },
  fil: {
    title: 'Mga mensahe',
    empty: 'Wala pang mensahe mula sa customer.',
    loading: 'Nilo-load ang mga mensahe…',
    reload: 'I-reload ang mga mensahe',
    failed: 'Hindi ma-load o ma-update ang mga mensahe. Subukang muli.',
    unnamed: 'Customer',
  },
}
const chatTranslations: Record<Exclude<Locale, 'en'>, ConversationCopy> = {
  hi: {
    conversation: 'बातचीत',
    openChat: 'बातचीत खोलें',
    back: 'वापस',
    reply: 'जवाब दें',
    send: 'संदेश भेजें',
    closeChat: 'बातचीत बंद करें',
    block: 'ग्राहक को ब्लॉक करें',
    blocked: 'ग्राहक ब्लॉक है',
    closed: 'बातचीत बंद है',
    unread: 'अपठित',
    you: 'आप',
    customer: 'ग्राहक',
    shop: 'दुकान',
    translate: 'अनुवाद देखें',
    original: 'मूल देखें',
    ai: 'AI अनुवाद · गलत हो सकता है',
    fixture: 'नमूना अनुवाद · ऑफ़लाइन, लाइव AI जुड़ा नहीं है',
    remove: 'यह बातचीत मिटाएँ',
    confirmDelete: 'यह बातचीत हमेशा के लिए मिटाएँ?',
    confirmBlock: 'ग्राहक के और संदेश ब्लॉक करें?',
    cancel: 'रद्द करें',
    chatFailed: 'बातचीत अपडेट नहीं हुई। फिर कोशिश करें।',
    invalid: '500 अक्षर तक का संदेश लिखें।',
    chatLoading: 'बातचीत लोड हो रही है…',
    polling: 'लाइव कनेक्शन नहीं · हर 15 सेकंड में जाँच',
    storage: 'ब्राउज़र पहुँच सहेज नहीं पाया। बातचीत जारी रखने के लिए पेज खुला रखें।',
    lost: 'यह बातचीत अब उपलब्ध नहीं है।',
  },
  bn: {
    conversation: 'কথোপকথন',
    openChat: 'কথোপকথন খুলুন',
    back: 'ফিরুন',
    reply: 'উত্তর দিন',
    send: 'বার্তা পাঠান',
    closeChat: 'কথোপকথন বন্ধ করুন',
    block: 'ক্রেতাকে ব্লক করুন',
    blocked: 'ক্রেতা ব্লক করা',
    closed: 'কথোপকথন বন্ধ',
    unread: 'পড়া হয়নি',
    you: 'আপনি',
    customer: 'ক্রেতা',
    shop: 'দোকান',
    translate: 'অনুবাদ দেখুন',
    original: 'মূল দেখুন',
    ai: 'AI অনুবাদ · ভুল হতে পারে',
    fixture: 'নমুনা অনুবাদ · অফলাইন, লাইভ AI যুক্ত নয়',
    remove: 'এই কথোপকথন মুছুন',
    confirmDelete: 'এই কথোপকথন স্থায়ীভাবে মুছবেন?',
    confirmBlock: 'এই ক্রেতার আরও বার্তা ব্লক করবেন?',
    cancel: 'বাতিল করুন',
    chatFailed: 'কথোপকথন আপডেট হয়নি। আবার চেষ্টা করুন।',
    invalid: '৫০০ অক্ষরের মধ্যে বার্তা লিখুন।',
    chatLoading: 'কথোপকথন লোড হচ্ছে…',
    polling: 'লাইভ সংযোগ নেই · প্রতি ১৫ সেকেন্ডে যাচাই',
    storage: 'ব্রাউজার প্রবেশাধিকার সেভ করতে পারেনি। কথা চালাতে পেজ খোলা রাখুন।',
    lost: 'এই কথোপকথন আর নেই।',
  },
  te: {
    conversation: 'సంభాషణ',
    openChat: 'సంభాషణ తెరవండి',
    back: 'వెనక్కి',
    reply: 'జవాబివ్వండి',
    send: 'సందేశం పంపండి',
    closeChat: 'సంభాషణ మూసివేయండి',
    block: 'కస్టమర్‌ను బ్లాక్ చేయండి',
    blocked: 'కస్టమర్ బ్లాక్ అయ్యారు',
    closed: 'సంభాషణ మూసివేశారు',
    unread: 'చదవలేదు',
    you: 'మీరు',
    customer: 'కస్టమర్',
    shop: 'దుకాణం',
    translate: 'అనువాదం చూడండి',
    original: 'అసలు చూడండి',
    ai: 'AI అనువాదం · తప్పులు ఉండవచ్చు',
    fixture: 'నమూనా అనువాదం · ఆఫ్‌లైన్, లైవ్ AI కనెక్ట్ కాలేదు',
    remove: 'ఈ సంభాషణ తొలగించండి',
    confirmDelete: 'ఈ సంభాషణ శాశ్వతంగా తొలగించాలా?',
    confirmBlock: 'ఈ కస్టమర్ మరిన్ని సందేశాలు పంపకుండా బ్లాక్ చేయాలా?',
    cancel: 'రద్దు చేయండి',
    chatFailed: 'సంభాషణ నవీకరించలేకపోయాం. మళ్లీ ప్రయత్నించండి.',
    invalid: '500 అక్షరాల వరకు సందేశం రాయండి.',
    chatLoading: 'సంభాషణ లోడ్ అవుతోంది…',
    polling: 'లైవ్ కనెక్షన్ లేదు · ప్రతి 15 సెకన్లకు తనిఖీ',
    storage: 'బ్రౌజర్ యాక్సెస్ సేవ్ చేయలేదు. చాట్ కొనసాగించడానికి పేజీ తెరిచి ఉంచండి.',
    lost: 'ఈ సంభాషణ ఇక అందుబాటులో లేదు.',
  },
  mr: {
    conversation: 'गप्पा',
    openChat: 'गप्पा उघडा',
    back: 'मागे',
    reply: 'उत्तर द्या',
    send: 'संदेश पाठवा',
    closeChat: 'गप्पा बंद करा',
    block: 'ग्राहकाला ब्लॉक करा',
    blocked: 'ग्राहक ब्लॉक केला',
    closed: 'गप्पा बंद आहेत',
    unread: 'न वाचलेले',
    you: 'तुम्ही',
    customer: 'ग्राहक',
    shop: 'दुकान',
    translate: 'भाषांतर पाहा',
    original: 'मूळ पाहा',
    ai: 'AI भाषांतर · चुकू शकते',
    fixture: 'नमुना भाषांतर · ऑफलाइन, लाइव्ह AI जोडलेले नाही',
    remove: 'या गप्पा मिटवा',
    confirmDelete: 'या गप्पा कायमच्या मिटवायच्या?',
    confirmBlock: 'या ग्राहकाचे पुढील संदेश ब्लॉक करायचे?',
    cancel: 'रद्द करा',
    chatFailed: 'गप्पा अपडेट झाल्या नाहीत. पुन्हा प्रयत्न करा.',
    invalid: '500 अक्षरांपर्यंतचा संदेश लिहा.',
    chatLoading: 'गप्पा लोड करत आहोत…',
    polling: 'लाइव्ह जोडणी नाही · दर 15 सेकंदांनी तपासणी',
    storage: 'ब्राउझर प्रवेश जतन करू शकला नाही. गप्पांसाठी पेज उघडे ठेवा.',
    lost: 'या गप्पा आता उपलब्ध नाहीत.',
  },
  kn: {
    conversation: 'ಮಾತುಕತೆ',
    openChat: 'ಮಾತುಕತೆ ತೆರೆಯಿರಿ',
    back: 'ಹಿಂದಕ್ಕೆ',
    reply: 'ಉತ್ತರಿಸಿ',
    send: 'ಸಂದೇಶ ಕಳುಹಿಸಿ',
    closeChat: 'ಮಾತುಕತೆ ಮುಚ್ಚಿ',
    block: 'ಗ್ರಾಹಕರನ್ನು ಬ್ಲಾಕ್ ಮಾಡಿ',
    blocked: 'ಗ್ರಾಹಕರನ್ನು ಬ್ಲಾಕ್ ಮಾಡಲಾಗಿದೆ',
    closed: 'ಮಾತುಕತೆ ಮುಚ್ಚಿದೆ',
    unread: 'ಓದಿಲ್ಲ',
    you: 'ನೀವು',
    customer: 'ಗ್ರಾಹಕ',
    shop: 'ಅಂಗಡಿ',
    translate: 'ಅನುವಾದ ನೋಡಿ',
    original: 'ಮೂಲ ನೋಡಿ',
    ai: 'AI ಅನುವಾದ · ತಪ್ಪಿರಬಹುದು',
    fixture: 'ಮಾದರಿ ಅನುವಾದ · ಆಫ್‌ಲೈನ್, ನೇರ AI ಸಂಪರ್ಕಿಸಿಲ್ಲ',
    remove: 'ಈ ಮಾತುಕತೆ ಅಳಿಸಿ',
    confirmDelete: 'ಈ ಮಾತುಕತೆ ಶಾಶ್ವತವಾಗಿ ಅಳಿಸಬೇಕೇ?',
    confirmBlock: 'ಈ ಗ್ರಾಹಕರ ಮುಂದಿನ ಸಂದೇಶಗಳನ್ನು ಬ್ಲಾಕ್ ಮಾಡಬೇಕೇ?',
    cancel: 'ರದ್ದುಮಾಡಿ',
    chatFailed: 'ಮಾತುಕತೆ ನವೀಕರಿಸಲಾಗಲಿಲ್ಲ. ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಿ.',
    invalid: '500 ಅಕ್ಷರಗಳೊಳಗಿನ ಸಂದೇಶ ಬರೆಯಿರಿ.',
    chatLoading: 'ಮಾತುಕತೆ ಲೋಡ್ ಆಗುತ್ತಿದೆ…',
    polling: 'ನೇರ ಸಂಪರ್ಕ ಇಲ್ಲ · ಪ್ರತಿ 15 ಸೆಕೆಂಡ್‌ಗೆ ಪರಿಶೀಲನೆ',
    storage: 'ಬ್ರೌಸರ್ ಪ್ರವೇಶ ಉಳಿಸಲಾಗಲಿಲ್ಲ. ಮಾತುಕತೆ ಮುಂದುವರಿಸಲು ಪೇಜ್ ತೆರೆದಿಡಿ.',
    lost: 'ಈ ಮಾತುಕತೆ ಇನ್ನು ಲಭ್ಯವಿಲ್ಲ.',
  },

  'zh-Hans': {
    conversation: '对话',
    openChat: '打开对话',
    back: '返回',
    reply: '回复',
    send: '发送消息',
    closeChat: '关闭对话',
    block: '屏蔽顾客',
    blocked: '顾客已被屏蔽',
    closed: '对话已关闭',
    unread: '未读',
    you: '你',
    customer: '顾客',
    shop: '店家',
    translate: '查看翻译',
    original: '查看原文',
    ai: 'AI 翻译 · 可能不准确',
    fixture: '模拟翻译 · 离线示例，未连接实时 AI',
    remove: '删除此对话',
    confirmDelete: '永久删除此对话？',
    confirmBlock: '屏蔽此顾客，不再接收消息？',
    cancel: '取消',
    chatFailed: '无法更新对话，请重试。',
    invalid: '请输入不超过 500 字的消息。',
    chatLoading: '正在加载对话…',
    polling: '实时连接不可用 · 每 15 秒检查一次',
    storage: '浏览器无法保存访问权限，请保持此页面打开。',
    lost: '此对话已不可用。',
  },
  ms: {
    conversation: 'Perbualan',
    openChat: 'Buka perbualan',
    back: 'Kembali',
    reply: 'Balas',
    send: 'Hantar mesej',
    closeChat: 'Tutup perbualan',
    block: 'Sekat pelanggan',
    blocked: 'Pelanggan disekat',
    closed: 'Perbualan ditutup',
    unread: 'Belum dibaca',
    you: 'Anda',
    customer: 'Pelanggan',
    shop: 'Kedai',
    translate: 'Lihat terjemahan',
    original: 'Lihat asal',
    ai: 'Terjemahan AI · mungkin tidak tepat',
    fixture: 'Terjemahan simulasi · contoh luar talian, tiada AI langsung',
    remove: 'Padam perbualan ini',
    confirmDelete: 'Padam perbualan ini secara kekal?',
    confirmBlock: 'Sekat pelanggan ini daripada menghantar mesej lagi?',
    cancel: 'Batal',
    chatFailed: 'Tidak dapat mengemas kini perbualan. Cuba lagi.',
    invalid: 'Masukkan mesej sehingga 500 aksara.',
    chatLoading: 'Memuatkan perbualan…',
    polling: 'Sambungan langsung tidak tersedia · semak setiap 15 saat',
    storage: 'Pelayar tidak dapat menyimpan akses. Biarkan halaman ini terbuka.',
    lost: 'Perbualan ini tidak lagi tersedia.',
  },
  ta: {
    conversation: 'உரையாடல்',
    openChat: 'உரையாடலைத் திற',
    back: 'பின்',
    reply: 'பதில்',
    send: 'செய்தி அனுப்பு',
    closeChat: 'உரையாடலை மூடு',
    block: 'வாடிக்கையாளரைத் தடு',
    blocked: 'வாடிக்கையாளர் தடுக்கப்பட்டார்',
    closed: 'உரையாடல் மூடப்பட்டது',
    unread: 'படிக்காதது',
    you: 'நீங்கள்',
    customer: 'வாடிக்கையாளர்',
    shop: 'கடை',
    translate: 'மொழிபெயர்ப்பைக் காண்',
    original: 'அசலைக் காண்',
    ai: 'AI மொழிபெயர்ப்பு · தவறுகள் இருக்கலாம்',
    fixture: 'மாதிரி மொழிபெயர்ப்பு · இணையமில்லா உதாரணம், நேரடி AI இல்லை',
    remove: 'இந்த உரையாடலை நீக்கு',
    confirmDelete: 'இந்த உரையாடலை நிரந்தரமாக நீக்கவா?',
    confirmBlock: 'இந்த வாடிக்கையாளர் மேலும் செய்தி அனுப்புவதைத் தடுக்கவா?',
    cancel: 'ரத்து',
    chatFailed: 'உரையாடலைப் புதுப்பிக்க முடியவில்லை. மீண்டும் முயலவும்.',
    invalid: '500 எழுத்துகள் வரை செய்தியை உள்ளிடவும்.',
    chatLoading: 'உரையாடல் ஏற்றப்படுகிறது…',
    polling: 'நேரடி இணைப்பு இல்லை · 15 வினாடிகளுக்கு ஒருமுறை சரிபார்க்கிறது',
    storage: 'உலாவியால் அணுகலைச் சேமிக்க முடியவில்லை. இந்தப் பக்கத்தைத் திறந்தே வைக்கவும்.',
    lost: 'இந்த உரையாடல் இனி கிடைக்காது.',
  },
  ja: {
    conversation: '会話',
    openChat: '会話を開く',
    back: '戻る',
    reply: '返信',
    send: 'メッセージを送信',
    closeChat: '会話を終了',
    block: 'お客様をブロック',
    blocked: 'ブロック済み',
    closed: '会話は終了しました',
    unread: '未読',
    you: 'あなた',
    customer: 'お客様',
    shop: 'お店',
    translate: '翻訳を見る',
    original: '原文を見る',
    ai: 'AI 翻訳 · 不正確な場合があります',
    fixture: '模擬翻訳 · オフラインの例、ライブ AI 未接続',
    remove: 'この会話を削除',
    confirmDelete: 'この会話を完全に削除しますか？',
    confirmBlock: 'このお客様からのメッセージをブロックしますか？',
    cancel: 'キャンセル',
    chatFailed: '会話を更新できません。もう一度お試しください。',
    invalid: '500 文字以内で入力してください。',
    chatLoading: '会話を読み込み中…',
    polling: 'ライブ接続不可 · 15 秒ごとに確認',
    storage: 'アクセスを保存できません。このページを開いたままにしてください。',
    lost: 'この会話は利用できなくなりました。',
  },
  ko: {
    conversation: '대화',
    openChat: '대화 열기',
    back: '뒤로',
    reply: '답장',
    send: '메시지 보내기',
    closeChat: '대화 종료',
    block: '고객 차단',
    blocked: '차단된 고객',
    closed: '종료된 대화',
    unread: '읽지 않음',
    you: '나',
    customer: '고객',
    shop: '가게',
    translate: '번역 보기',
    original: '원문 보기',
    ai: 'AI 번역 · 정확하지 않을 수 있습니다',
    fixture: '모의 번역 · 오프라인 예시, 실시간 AI 미연결',
    remove: '이 대화 삭제',
    confirmDelete: '이 대화를 영구 삭제할까요?',
    confirmBlock: '이 고객의 추가 메시지를 차단할까요?',
    cancel: '취소',
    chatFailed: '대화를 업데이트할 수 없습니다. 다시 시도하세요.',
    invalid: '500자 이내로 입력하세요.',
    chatLoading: '대화 불러오는 중…',
    polling: '실시간 연결 불가 · 15초마다 확인',
    storage: '브라우저가 접근 정보를 저장할 수 없습니다. 이 페이지를 열어 두세요.',
    lost: '이 대화는 더 이상 사용할 수 없습니다.',
  },
  id: {
    conversation: 'Percakapan',
    openChat: 'Buka percakapan',
    back: 'Kembali',
    reply: 'Balas',
    send: 'Kirim pesan',
    closeChat: 'Tutup percakapan',
    block: 'Blokir pelanggan',
    blocked: 'Pelanggan diblokir',
    closed: 'Percakapan ditutup',
    unread: 'Belum dibaca',
    you: 'Anda',
    customer: 'Pelanggan',
    shop: 'Toko',
    translate: 'Lihat terjemahan',
    original: 'Lihat asli',
    ai: 'Terjemahan AI · mungkin tidak akurat',
    fixture: 'Terjemahan simulasi · contoh luring, AI langsung tidak terhubung',
    remove: 'Hapus percakapan ini',
    confirmDelete: 'Hapus percakapan ini secara permanen?',
    confirmBlock: 'Blokir pelanggan ini agar tidak mengirim pesan lagi?',
    cancel: 'Batal',
    chatFailed: 'Tidak dapat memperbarui percakapan. Coba lagi.',
    invalid: 'Masukkan pesan hingga 500 karakter.',
    chatLoading: 'Memuat percakapan…',
    polling: 'Koneksi langsung tidak tersedia · diperiksa setiap 15 detik',
    storage: 'Browser tidak dapat menyimpan akses. Biarkan halaman ini terbuka.',
    lost: 'Percakapan ini tidak lagi tersedia.',
  },
  th: {
    conversation: 'การสนทนา',
    openChat: 'เปิดการสนทนา',
    back: 'กลับ',
    reply: 'ตอบกลับ',
    send: 'ส่งข้อความ',
    closeChat: 'ปิดการสนทนา',
    block: 'บล็อกลูกค้า',
    blocked: 'บล็อกลูกค้าแล้ว',
    closed: 'ปิดการสนทนาแล้ว',
    unread: 'ยังไม่อ่าน',
    you: 'คุณ',
    customer: 'ลูกค้า',
    shop: 'ร้าน',
    translate: 'ดูคำแปล',
    original: 'ดูต้นฉบับ',
    ai: 'คำแปล AI · อาจไม่ถูกต้อง',
    fixture: 'คำแปลจำลอง · ตัวอย่างออฟไลน์ ไม่ได้เชื่อมต่อ AI สด',
    remove: 'ลบการสนทนานี้',
    confirmDelete: 'ลบการสนทนานี้ถาวรหรือไม่?',
    confirmBlock: 'บล็อกลูกค้ารายนี้ไม่ให้ส่งข้อความอีกหรือไม่?',
    cancel: 'ยกเลิก',
    chatFailed: 'อัปเดตการสนทนาไม่ได้ โปรดลองอีกครั้ง',
    invalid: 'ป้อนข้อความไม่เกิน 500 ตัวอักษร',
    chatLoading: 'กำลังโหลดการสนทนา…',
    polling: 'เชื่อมต่อสดไม่ได้ · ตรวจทุก 15 วินาที',
    storage: 'เบราว์เซอร์บันทึกสิทธิ์ไม่ได้ โปรดเปิดหน้านี้ไว้',
    lost: 'การสนทนานี้ไม่พร้อมใช้งานแล้ว',
  },
  vi: {
    conversation: 'Cuộc trò chuyện',
    openChat: 'Mở cuộc trò chuyện',
    back: 'Quay lại',
    reply: 'Trả lời',
    send: 'Gửi tin nhắn',
    closeChat: 'Đóng cuộc trò chuyện',
    block: 'Chặn khách hàng',
    blocked: 'Khách hàng đã bị chặn',
    closed: 'Cuộc trò chuyện đã đóng',
    unread: 'Chưa đọc',
    you: 'Bạn',
    customer: 'Khách hàng',
    shop: 'Cửa hàng',
    translate: 'Xem bản dịch',
    original: 'Xem bản gốc',
    ai: 'Bản dịch AI · có thể không chính xác',
    fixture: 'Bản dịch mô phỏng · ví dụ ngoại tuyến, chưa kết nối AI trực tiếp',
    remove: 'Xóa cuộc trò chuyện này',
    confirmDelete: 'Xóa vĩnh viễn cuộc trò chuyện này?',
    confirmBlock: 'Chặn khách hàng này gửi thêm tin nhắn?',
    cancel: 'Hủy',
    chatFailed: 'Không thể cập nhật cuộc trò chuyện. Vui lòng thử lại.',
    invalid: 'Nhập tin nhắn tối đa 500 ký tự.',
    chatLoading: 'Đang tải cuộc trò chuyện…',
    polling: 'Không có kết nối trực tiếp · kiểm tra mỗi 15 giây',
    storage: 'Trình duyệt không thể lưu quyền truy cập. Hãy giữ trang này mở.',
    lost: 'Cuộc trò chuyện này không còn khả dụng.',
  },
  fil: {
    conversation: 'Pag-uusap',
    openChat: 'Buksan ang pag-uusap',
    back: 'Bumalik',
    reply: 'Sumagot',
    send: 'Magpadala ng mensahe',
    closeChat: 'Isara ang pag-uusap',
    block: 'I-block ang customer',
    blocked: 'Naka-block ang customer',
    closed: 'Sarado na ang pag-uusap',
    unread: 'Hindi pa nababasa',
    you: 'Ikaw',
    customer: 'Customer',
    shop: 'Tindahan',
    translate: 'Tingnan ang salin',
    original: 'Tingnan ang orihinal',
    ai: 'Salin ng AI · maaaring hindi tumpak',
    fixture: 'Simuladong salin · offline na halimbawa, walang live AI',
    remove: 'Burahin ang pag-uusap na ito',
    confirmDelete: 'Permanenteng burahin ang pag-uusap na ito?',
    confirmBlock: 'I-block ang customer na ito sa pagpapadala ng mga mensahe?',
    cancel: 'Kanselahin',
    chatFailed: 'Hindi ma-update ang pag-uusap. Subukang muli.',
    invalid: 'Maglagay ng mensaheng hanggang 500 character.',
    chatLoading: 'Nilo-load ang pag-uusap…',
    polling: 'Walang live na koneksyon · sinusuri kada 15 segundo',
    storage: 'Hindi mai-save ng browser ang access. Panatilihing bukas ang pahinang ito.',
    lost: 'Hindi na available ang pag-uusap na ito.',
  },
}

type Inquiry = components['schemas']['Inquiry']

export function Messages({ businessId }: { businessId: string }) {
  const guest = useGuestCopy()
  const locale = useLocale()
  const t = {
    ...en,
    ...(locale === 'en' ? {} : { ...translations[locale], ...chatTranslations[locale] }),
  }
  const { api } = useWorkspace()
  const [items, setItems] = useState<Inquiry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [polling, setPolling] = useState(false)
  const [busy, setBusy] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [confirmBlock, setConfirmBlock] = useState(false)
  const [tips, setTips] = useState<TipList | null>(null)
  const lifetime = useRef<AbortController | null>(null)
  const path = `/businesses/${encodeURIComponent(businessId)}/inquiries`
  const load = useCallback(
    (signal: AbortSignal) =>
      api<Inquiry[]>(path, { signal: AbortSignal.any([signal, AbortSignal.timeout(25_000)]) })
        .then((result) => {
          if (!signal.aborted) {
            setItems(result)
            setError(false)
          }
        })
        .catch(() => {
          if (!signal.aborted) setError(true)
        })
        .finally(() => {
          if (!signal.aborted) setLoading(false)
          // Neighbour tips wake the same inbox signal; they never block the messages.
          api<TipList>(`/businesses/${encodeURIComponent(businessId)}/tips`, { signal }).then(
            (result) => {
              if (!signal.aborted) setTips(result)
            },
            () => undefined,
          )
        }),
    [api, path, businessId],
  )
  useEffect(() => {
    const abort = new AbortController()
    lifetime.current = abort
    let timer: ReturnType<typeof setInterval> | undefined
    void load(abort.signal)
    void followInquiries(
      (init) => api<Response>(`${path}/stream`, { ...init, raw: true }),
      abort.signal,
      () => {
        void load(abort.signal)
      },
    ).catch(() => {
      if (abort.signal.aborted) return
      setPolling(true)
      void load(abort.signal)
      timer = setInterval(() => {
        void load(abort.signal)
      }, 15_000)
    })
    return () => {
      abort.abort()
      clearInterval(timer)
    }
  }, [api, path, load])
  const thread = items.find((item) => item.id === selected)
  const update = async (id: string, action: string, text?: string) => {
    const result = await api<Inquiry>(`${path}/${encodeURIComponent(id)}/${action}`, {
      method: 'POST',
      body: text === undefined ? undefined : JSON.stringify({ text }),
      signal: lifetime.current?.signal,
    })
    setItems((current) => current.map((item) => (item.id === result.id ? result : item)))
  }
  return (
    <Box component="section" aria-labelledby="messages-title">
      <Stack direction="row" sx={{ gap: 1, alignItems: 'center', flexWrap: 'wrap' }}>
        <Typography id="messages-title" component="h2" variant="titleLarge" sx={{ flex: 1 }}>
          {t.title} ({items.filter((item) => item.unread && !item.done).length})
        </Typography>
        <Button
          disabled={loading || busy}
          onClick={() => {
            if (lifetime.current) void load(lifetime.current.signal)
          }}
          startIcon={loading ? <CircularProgress size={16} /> : undefined}
        >
          {t.reload}
        </Button>
      </Stack>
      {polling && (
        <Typography role="status" variant="bodySmall">
          {t.polling}
        </Typography>
      )}
      {error && (
        <Alert severity="error" sx={{ mt: 2 }}>
          {t.failed}
        </Alert>
      )}
      {loading && (
        <Typography role="status" variant="bodyMedium">
          {t.loading}
        </Typography>
      )}
      {thread ? (
        <Stack spacing={2} sx={{ mt: 2 }}>
          <Button
            onClick={() => {
              setSelected(null)
              setConfirmBlock(false)
            }}
            sx={{ alignSelf: 'flex-start' }}
          >
            {t.back}
          </Button>
          <Typography component="h3" variant="titleMedium">
            {thread.name || t.unnamed}
          </Typography>
          {!thread.contact.endsWith('@guest.invalid') && (
            <Typography variant="bodyMedium" sx={{ overflowWrap: 'anywhere' }}>
              {thread.contact}
            </Typography>
          )}
          <ConversationView
            key={thread.id}
            thread={thread}
            viewer="owner"
            copy={t}
            onSend={async (text) => {
              await update(thread.id, 'messages', text)
            }}
            onTranslate={(id) =>
              api<Translation>(`${path}/${thread.id}/messages/${id}/translation`, {
                method: 'POST',
                body: JSON.stringify({ language: locale }),
                signal: lifetime.current?.signal,
              })
            }
          />
          <Stack direction="row" sx={{ gap: 1, flexWrap: 'wrap' }}>
            {!thread.done && (
              <Button
                disabled={busy}
                onClick={async () => {
                  setBusy(true)
                  setError(false)
                  try {
                    await update(thread.id, 'done')
                  } catch {
                    setError(true)
                  } finally {
                    setBusy(false)
                  }
                }}
              >
                {t.closeChat}
              </Button>
            )}
            {thread.blocked && (
              <Button
                disabled={busy}
                onClick={async () => {
                  setBusy(true)
                  setError(false)
                  try {
                    await update(thread.id, 'unblock')
                  } catch {
                    setError(true)
                  } finally {
                    setBusy(false)
                  }
                }}
              >
                {guest.unblock}
              </Button>
            )}
            {!thread.blocked && (
              <Button disabled={busy} color="error" onClick={() => setConfirmBlock(true)}>
                {t.block}
              </Button>
            )}
          </Stack>
          {confirmBlock && (
            <Box role="group" aria-label={t.confirmBlock}>
              <Typography variant="bodyMedium">{t.confirmBlock}</Typography>
              <Button
                disabled={busy}
                color="error"
                onClick={async () => {
                  setBusy(true)
                  setError(false)
                  try {
                    await update(thread.id, 'block')
                    setConfirmBlock(false)
                  } catch {
                    setError(true)
                  } finally {
                    setBusy(false)
                  }
                }}
              >
                {t.block}
              </Button>
              <Button disabled={busy} onClick={() => setConfirmBlock(false)}>
                {t.cancel}
              </Button>
            </Box>
          )}
        </Stack>
      ) : (
        <>
          {!loading && items.length === 0 && (
            <Typography variant="bodyMedium" sx={{ mt: 2 }}>
              {t.empty}
            </Typography>
          )}
          <Stack
            component="ul"
            divider={<Divider component="li" aria-hidden="true" />}
            sx={{ p: 0, listStyle: 'none' }}
          >
            {items.map((item) => (
              <Box component="li" key={item.id} sx={{ py: 2, overflowWrap: 'anywhere' }}>
                <Typography component="h3" variant="titleMedium">
                  {item.name || t.unnamed}
                </Typography>
                {!item.contact.endsWith('@guest.invalid') && (
                  <Typography variant="bodyMedium">{item.contact}</Typography>
                )}
                <Typography variant="bodyLarge" sx={{ whiteSpace: 'pre-wrap' }}>
                  {/* The latest words from a person, not the AI's instant answer. */}
                  {item.messages?.filter((m) => m.kind !== 'ai').at(-1)?.text ?? item.message}
                </Typography>
                <Typography variant="labelMedium">
                  {item.blocked ? t.blocked : item.done ? t.closed : item.unread ? t.unread : ''}
                </Typography>
                <Button
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true)
                    setError(false)
                    try {
                      await update(item.id, 'read')
                      setSelected(item.id)
                    } catch {
                      setError(true)
                    } finally {
                      setBusy(false)
                    }
                  }}
                >
                  {t.openChat}
                </Button>
              </Box>
            ))}
          </Stack>
          <OwnerTips list={tips} />
        </>
      )}
    </Box>
  )
}
