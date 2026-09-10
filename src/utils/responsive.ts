import { onBeforeUnmount, onMounted, readonly, ref, type Ref } from 'vue';

/** 移动端布局断点（各组件 CSS 媒体查询与此保持一致）。 */
export const MOBILE_MAX_WIDTH = 900;
export const MOBILE_QUERY = `(max-width: ${MOBILE_MAX_WIDTH}px)`;

/** 当前是否为触屏/窄屏设备（用于需要改变 DOM 或数据量的场景，纯样式请用媒体查询）。 */
export function isMobileViewport(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(MOBILE_QUERY).matches
    : false;
}

/**
 * 响应式断点：命中手机/窄屏返回 true，并随视口（含横竖屏切换）变化而更新。
 * 样式层由 CSS 媒体查询负责；此 composable 仅用于需要改变 DOM 结构或渲染数量的场景。
 */
export function useIsMobile(): Readonly<Ref<boolean>> {
  const isMobile = ref(isMobileViewport());
  let query: MediaQueryList | null = null;
  const sync = (event: MediaQueryList | MediaQueryListEvent) => {
    isMobile.value = event.matches;
  };

  onMounted(() => {
    query = window.matchMedia(MOBILE_QUERY);
    sync(query);
    query.addEventListener('change', sync);
  });

  onBeforeUnmount(() => {
    query?.removeEventListener('change', sync);
    query = null;
  });

  return readonly(isMobile) as Readonly<Ref<boolean>>;
}
