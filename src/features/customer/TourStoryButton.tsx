import { useState } from 'react'
import { Alert, Button, Stack, Typography } from '@mui/material'
import type { Locale } from '../../i18n/locales'
import { useLocale } from '../../state/hooks'
import { setPassport, type PassportView } from '../passport/store'
import { goTo } from '../frontdoors/navigation'
import { useCustomer } from './account'
import type { Me } from './types'

// The explicit demo action is account content, never an inferred preference.
const copy: Record<Locale, [string, string, string]> = {
  en: [
    'Load demo story',
    'Fictional shops, chats and rewards.',
    'Could not load. Try again with a fresh demo account.',
  ],
  'zh-Hans': ['加载演示故事', '虚构的商店、聊天和奖励。', '无法加载，请用新演示账号重试。'],
  ms: [
    'Muatkan cerita demo',
    'Kedai, sembang dan ganjaran rekaan.',
    'Tidak dapat dimuatkan. Cuba dengan akaun demo baharu.',
  ],
  ta: [
    'செயல்விளக்கத்தை ஏற்று',
    'கற்பனைக் கடைகள், உரையாடல்கள், வெகுமதிகள்.',
    'ஏற்ற முடியவில்லை. புதிய செயல்விளக்கக் கணக்கில் முயலவும்.',
  ],
  ja: [
    'デモを読み込む',
    '架空のお店、チャット、特典です。',
    '読み込めませんでした。新しいデモアカウントで再試行してください。',
  ],
  ko: [
    '데모 불러오기',
    '가상 매장, 대화, 보상입니다.',
    '불러오지 못했어요. 새 데모 계정으로 다시 시도하세요.',
  ],
  id: [
    'Muat cerita demo',
    'Toko, obrolan, dan hadiah fiktif.',
    'Gagal memuat. Coba dengan akun demo baru.',
  ],
  th: [
    'โหลดเรื่องราวสาธิต',
    'ร้านค้า แชต และรางวัลสมมติ',
    'โหลดไม่ได้ ลองอีกครั้งด้วยบัญชีสาธิตใหม่',
  ],
  vi: [
    'Tải bản demo',
    'Cửa hàng, trò chuyện và phần thưởng giả lập.',
    'Không tải được. Hãy thử lại bằng tài khoản demo mới.',
  ],
  fil: [
    'I-load ang demo',
    'Kathang-isip na mga tindahan, chat at gantimpala.',
    'Hindi ma-load. Subukan gamit ang bagong demo account.',
  ],
  hi: [
    'डेमो कहानी खोलें',
    'काल्पनिक दुकानें, बातचीत और इनाम।',
    'खुल नहीं सका। नए डेमो खाते से फिर कोशिश करें।',
  ],
  bn: [
    'ডেমো গল্প খুলুন',
    'কাল্পনিক দোকান, কথোপকথন ও পুরস্কার।',
    'খোলা যায়নি। নতুন ডেমো অ্যাকাউন্ট দিয়ে আবার চেষ্টা করুন।',
  ],
  te: [
    'డెమో కథ తెరవండి',
    'కల్పిత దుకాణాలు, చాట్‌లు, బహుమతులు.',
    'తెరవలేకపోయాం. కొత్త డెమో ఖాతాతో మళ్లీ ప్రయత్నించండి.',
  ],
  mr: [
    'डेमो कथा उघडा',
    'काल्पनिक दुकाने, गप्पा आणि बक्षिसे.',
    'उघडता आले नाही. नवीन डेमो खात्यातून पुन्हा प्रयत्न करा.',
  ],
  kn: [
    'ಡೆಮೊ ಕಥೆ ತೆರೆಯಿರಿ',
    'ಕಾಲ್ಪನಿಕ ಅಂಗಡಿಗಳು, ಮಾತುಕತೆಗಳು ಮತ್ತು ಬಹುಮಾನಗಳು.',
    'ತೆರೆಯಲಾಗಲಿಲ್ಲ. ಹೊಸ ಡೆಮೊ ಖಾತೆಯಿಂದ ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಿ.',
  ],
}

export function TourStoryButton({ onReady }: { onReady: () => void }) {
  const account = useCustomer()
  const [label, body, error] = copy[useLocale()]
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle')
  async function load() {
    setStatus('loading')
    try {
      const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
      const demo = await account.api<{ place: { lat: number; lng: number; label: string } }>(
        `/api/v1/demo/customer?zone=${encodeURIComponent(zone)}`,
        { method: 'POST' },
      )
      const [me, passport] = await Promise.all([
        account.api<Me>('/api/v1/customer/me'),
        account.api<PassportView>('/api/v1/customer/passport'),
      ])
      if (me.profile) account.setProfile(me.profile)
      setPassport(passport)
      account.refreshUnread()
      try {
        const saved = JSON.parse(localStorage.getItem('chalkboard.discover.filters') || '{}') as {
          place?: unknown
        }
        if (!saved.place)
          localStorage.setItem(
            'chalkboard.discover.filters',
            JSON.stringify({ ...saved, place: demo.place }),
          )
      } catch {
        // Optional location memory; the passport remains available without storage.
      }
      setStatus('idle')
      onReady()
      goTo('/explore/passport')
    } catch {
      setStatus('error')
    }
  }
  return (
    <Stack spacing={1}>
      <Typography variant="bodySmall" color="text.secondary">
        {body}
      </Typography>
      {status === 'error' && <Alert severity="error">{error}</Alert>}
      <Button
        variant="outlined"
        loading={status === 'loading'}
        onClick={() => void load()}
        sx={{ minHeight: 48 }}
      >
        {label}
      </Button>
    </Stack>
  )
}
