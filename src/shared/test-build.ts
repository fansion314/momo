export function tiziTestBuild(): boolean {
  return typeof __TIZI_TEST_BUILD__ !== 'undefined' && __TIZI_TEST_BUILD__
}
