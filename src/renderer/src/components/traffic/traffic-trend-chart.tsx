import { calcTraffic } from '@renderer/utils/calc'
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Filler,
  Tooltip,
  Legend,
  type ChartOptions,
  type ScriptableContext
} from 'chart.js'
import dayjs from '@renderer/utils/dayjs'
import React, { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Line } from 'react-chartjs-2'

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Filler, Tooltip, Legend)

interface TrendPoint {
  timestamp: number
  upload: number
  download: number
}

interface Props {
  data: TrendPoint[]
  bucketSizeMs: number
  timezone?: string
}

const TrafficTrendChart: React.FC<Props> = ({ data, bucketSizeMs, timezone }) => {
  const { t } = useTranslation()
  const labels = useMemo(
    () =>
      data.map((d) => {
        if (timezone)
          return new Intl.DateTimeFormat(undefined, {
            timeZone: timezone,
            month: '2-digit',
            day: '2-digit'
          }).format(d.timestamp)
        if (bucketSizeMs >= 86400000) return dayjs(d.timestamp).format('MM-DD')
        if (bucketSizeMs >= 3600000) return dayjs(d.timestamp).format('MM-DD HH:mm')
        return dayjs(d.timestamp).format('HH:mm')
      }),
    [data, bucketSizeMs, timezone]
  )

  const chartData = useMemo(
    () => ({
      labels,
      datasets: [
        {
          label: t('traffic.upload'),
          data: data.map((d) => d.upload),
          fill: true,
          backgroundColor: (ctx: ScriptableContext<'line'>) => {
            const { ctx: c, chartArea } = ctx.chart
            if (!chartArea) return 'transparent'
            const g = c.createLinearGradient(0, chartArea.top, 0, chartArea.bottom)
            g.addColorStop(0, 'rgba(34,197,94,0.4)')
            g.addColorStop(1, 'rgba(34,197,94,0)')
            return g
          },
          borderColor: 'rgba(34,197,94,0.8)',
          borderWidth: 1.5,
          pointRadius: data.length === 1 ? 3 : 0,
          pointHoverRadius: data.length === 1 ? 5 : undefined,
          tension: 0
        },
        {
          label: t('traffic.download'),
          data: data.map((d) => d.download),
          fill: true,
          backgroundColor: (ctx: ScriptableContext<'line'>) => {
            const { ctx: c, chartArea } = ctx.chart
            if (!chartArea) return 'transparent'
            const g = c.createLinearGradient(0, chartArea.top, 0, chartArea.bottom)
            g.addColorStop(0, 'rgba(59,130,246,0.4)')
            g.addColorStop(1, 'rgba(59,130,246,0)')
            return g
          },
          borderColor: 'rgba(59,130,246,0.8)',
          borderWidth: 1.5,
          pointRadius: data.length === 1 ? 3 : 0,
          pointHoverRadius: data.length === 1 ? 5 : undefined,
          tension: 0
        }
      ]
    }),
    [data, labels, t]
  )

  const options: ChartOptions<'line'> = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: {
        display: true,
        position: 'top',
        labels: { boxWidth: 12, font: { size: 11 } }
      },
      tooltip: {
        callbacks: {
          label: (ctx) => ` ${ctx.dataset.label} ${calcTraffic(ctx.parsed.y ?? 0)}`
        }
      }
    },
    scales: {
      x: {
        offset: data.length === 1,
        ticks: {
          maxTicksLimit: 8,
          maxRotation: 0,
          font: { size: 10 }
        },
        grid: { display: false }
      },
      y: {
        ticks: {
          callback: (v) => calcTraffic(Number(v)),
          font: { size: 10 }
        },
        grid: { color: 'rgba(128,128,128,0.1)' },
        min: 0
      }
    },
    animation: { duration: 0 }
  }

  if (data.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-foreground/40">—</div>
    )
  }

  return (
    <div role="img" aria-label={t('traffic.history.trend')} className="h-full">
      <Line data={chartData} options={options} />
    </div>
  )
}

export default TrafficTrendChart
