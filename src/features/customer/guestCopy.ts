import type { Locale } from '../../i18n/locales'
import { useLocale } from '../../state/hooks'

const en = {
  guest: 'Guest',
  privacy:
    'Guest activity stays with this browser. Shops see a guest ID. Clearing browser data can lose access.',
  claim: 'Sign in to claim your reward and keep your stamps.',
  title: 'Keep your rewards',
  unblock: 'Unblock customer',
}

export const guestTranslations: Record<Locale, typeof en> = {
  en,
  hi: {
    guest: 'मेहमान',
    privacy:
      'मेहमान की गतिविधि इस ब्राउज़र से जुड़ी है। दुकान को मेहमान आईडी दिखती है। ब्राउज़र डेटा मिटाने पर पहुँच खो सकती है।',
    claim: 'इनाम लेने और स्टैंप बचाने के लिए साइन इन करें।',
    title: 'अपने इनाम बचाएँ',
    unblock: 'ब्लॉक हटाएँ',
  },
  bn: {
    guest: 'অতিথি',
    privacy:
      'অতিথির কাজ এই ব্রাউজারের সঙ্গে থাকে। দোকান অতিথি আইডি দেখে। ব্রাউজারের ডেটা মুছলে প্রবেশ হারাতে পারেন।',
    claim: 'পুরস্কার নিতে ও স্ট্যাম্প রাখতে সাইন ইন করুন।',
    title: 'পুরস্কার রাখুন',
    unblock: 'ব্লক সরান',
  },
  te: {
    guest: 'అతిథి',
    privacy:
      'అతిథి కార్యకలాపాలు ఈ బ్రౌజర్‌తో ఉంటాయి. దుకాణాలకు అతిథి ఐడీ కనిపిస్తుంది. బ్రౌజర్ డేటా తొలగిస్తే యాక్సెస్ పోవచ్చు.',
    claim: 'బహుమతి పొందడానికి, స్టాంపులు ఉంచుకోవడానికి సైన్ ఇన్ చేయండి.',
    title: 'బహుమతులు ఉంచుకోండి',
    unblock: 'బ్లాక్ తొలగించండి',
  },
  mr: {
    guest: 'पाहुणे',
    privacy:
      'पाहुण्यांची कृती या ब्राउझरशी जोडलेली असते. दुकानांना पाहुणे आयडी दिसतो. ब्राउझर डेटा मिटवल्यास प्रवेश गमावू शकता.',
    claim: 'बक्षीस घेण्यासाठी आणि स्टॅम्प जपण्यासाठी साइन इन करा.',
    title: 'बक्षिसे जपा',
    unblock: 'ब्लॉक काढा',
  },
  kn: {
    guest: 'ಅತಿಥಿ',
    privacy:
      'ಅತಿಥಿ ಚಟುವಟಿಕೆ ಈ ಬ್ರೌಸರ್‌ಗೆ ಸೇರಿದೆ. ಅಂಗಡಿಗೆ ಅತಿಥಿ ಐಡಿ ಕಾಣುತ್ತದೆ. ಬ್ರೌಸರ್ ಡೇಟಾ ಅಳಿಸಿದರೆ ಪ್ರವೇಶ ಕಳೆದುಕೊಳ್ಳಬಹುದು.',
    claim: 'ಬಹುಮಾನ ಪಡೆಯಲು ಮತ್ತು ಸ್ಟ್ಯಾಂಪ್ ಉಳಿಸಲು ಸೈನ್ ಇನ್ ಮಾಡಿ.',
    title: 'ಬಹುಮಾನ ಉಳಿಸಿ',
    unblock: 'ಬ್ಲಾಕ್ ತೆಗೆಯಿರಿ',
  },
  ta: {
    guest: 'விருந்தினர்',
    privacy:
      'விருந்தினர் செயல்பாடு இந்த உலாவியுடன் இணைந்தது. கடைகளுக்கு விருந்தினர் ஐடி தெரியும். உலாவித் தரவை அழித்தால் அணுகல் இழக்கலாம்.',
    claim: 'பரிசைப் பெறவும் முத்திரைகளைச் சேமிக்கவும் உள்நுழையுங்கள்.',
    title: 'பரிசுகளைச் சேமிக்கவும்',
    unblock: 'தடையை நீக்கு',
  },
  'zh-Hans': {
    guest: '访客',
    privacy: '访客记录与此浏览器关联。店家只看到访客编号。清除浏览器数据可能导致无法找回记录。',
    claim: '登录以领取奖励并保存印章。',
    title: '保存奖励',
    unblock: '取消屏蔽',
  },
  ja: {
    guest: 'ゲスト',
    privacy:
      'ゲストの記録はこのブラウザに紐づきます。お店にはゲストIDが表示されます。ブラウザのデータを消すと記録にアクセスできなくなる場合があります。',
    claim: 'ログインして特典を受け取り、スタンプを保存しましょう。',
    title: '特典を保存',
    unblock: 'ブロック解除',
  },
  ko: {
    guest: '게스트',
    privacy:
      '게스트 활동은 이 브라우저에 연결됩니다. 가게에는 게스트 ID가 표시됩니다. 브라우저 데이터를 지우면 접근할 수 없게 될 수 있어요.',
    claim: '로그인하여 보상을 받고 스탬프를 보관하세요.',
    title: '보상 보관',
    unblock: '차단 해제',
  },
  th: {
    guest: 'ผู้เยี่ยมชม',
    privacy:
      'กิจกรรมผู้เยี่ยมชมผูกกับเบราว์เซอร์นี้ ร้านเห็นเพียงรหัสผู้เยี่ยมชม การล้างข้อมูลเบราว์เซอร์อาจทำให้เข้าถึงไม่ได้',
    claim: 'ลงชื่อเข้าใช้เพื่อรับรางวัลและเก็บแสตมป์',
    title: 'เก็บรางวัลของคุณ',
    unblock: 'เลิกบล็อกลูกค้า',
  },
  ms: {
    guest: 'Tetamu',
    privacy:
      'Aktiviti tetamu terikat pada pelayar ini. Kedai melihat ID tetamu. Memadam data pelayar boleh menghilangkan akses.',
    claim: 'Log masuk untuk menuntut ganjaran dan menyimpan setem.',
    title: 'Simpan ganjaran anda',
    unblock: 'Nyahsekat pelanggan',
  },
  id: {
    guest: 'Tamu',
    privacy:
      'Aktivitas tamu terhubung ke browser ini. Toko melihat ID tamu. Menghapus data browser dapat menghilangkan akses.',
    claim: 'Masuk untuk mengambil hadiah dan menyimpan stempel.',
    title: 'Simpan hadiah Anda',
    unblock: 'Buka blokir',
  },
  vi: {
    guest: 'Khách',
    privacy:
      'Hoạt động khách gắn với trình duyệt này. Cửa hàng thấy mã khách. Xóa dữ liệu trình duyệt có thể làm mất quyền truy cập.',
    claim: 'Đăng nhập để nhận thưởng và giữ tem.',
    title: 'Giữ phần thưởng',
    unblock: 'Bỏ chặn khách',
  },
  fil: {
    guest: 'Bisita',
    privacy:
      'Nakatali sa browser na ito ang aktibidad ng bisita. Guest ID lang ang nakikita ng tindahan. Maaaring mawala ang access kapag binura ang data ng browser.',
    claim: 'Mag-sign in para kunin ang reward at itago ang mga stamp.',
    title: 'Itago ang rewards',
    unblock: 'Alisin ang block',
  },
}

export function useGuestCopy() {
  return guestTranslations[useLocale()]
}
