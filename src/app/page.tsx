'use client'

import { useState } from 'react'
import dynamic from 'next/dynamic'
import Intro from '@/components/Intro'

const MapView = dynamic(() => import('@/components/MapView'), { ssr: false })

export default function Home() {
  const [started, setStarted] = useState(false)

  if (!started) return <Intro onStart={() => setStarted(true)} />
  return <MapView />
}

