/**
 * Charts barrel — U9 (single-renderer, KTD4). The ONLY entry point for charts:
 * everything renders through these `d3-shape` + `motion` + SVG primitives, so the
 * codebase never grows a chart-library zoo. Pure helpers (scales, geometry) are
 * exported too for testing + page-side precomputation.
 */

export { AreaCurve, type AreaCurvePoint, type AreaCurveProps } from './AreaCurve'
export { BarChart, type BarChartProps, type BarDatum } from './BarChart'
export { ChartTooltip, type ChartTooltipProps } from './ChartTooltip'
export { areaPath, linePath, type PixelPoint } from './geometry'
export { bandScale, linearScale, niceMax, ticks, type BandScale, type LinearScale } from './scales'
