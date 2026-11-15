// The elements of every mini demo: plain boxes, sizes in percent, colours from the app tokens (see demos.css).
// Each string is trusted, static markup of `<i class=".." style=".."></i>` boxes; `parseBoxes` turns it into React elements.
export const DEMO_BOXES: Record<string, string> = {
  panel: '<i class="sd"></i><i class="pn"></i><i class="r g" style="top:12%"></i><i class="r g" style="top:24%;width:20%"></i><i class="r ac" style="top:36%;width:16%"></i><i class="r gr" style="top:54%;width:14%"></i><i class="r rd" style="top:66%;width:9%"></i><i class="g2" style="left:22%;top:14%;width:34%;height:5%"></i><i class="g2" style="left:22%;top:25%;width:26%;height:5%"></i>',
  split: '<i class="sd"></i><i class="pa"></i><i class="pb"></i><i class="ln"></i><i class="tb"></i>',
  standby: '<i class="sd"></i><i class="br"></i><i class="c1 g"></i><i class="c2"></i><i class="dt"></i><i class="tk"></i><i class="w1 g2"></i><i class="w2 g2"></i><i class="w3 g2"></i>',
  artifact: '<i class="sd"></i><i class="c g2"></i><i class="c g2"></i><i class="c g2"></i><i class="ar"></i><i class="ah"></i><i class="pt"></i>',
  word: '<i class="pl"></i><i class="pl"></i><i class="pl"></i><i class="pg"></i><i class="h"></i><i class="tbl"></i>',
  dim: '<i class="s s1"></i><i class="s s2"></i><i class="s s3"></i><i class="rg"></i>',
  inbox: '<i class="sd"></i><i class="ok"></i><i class="ck"></i><i class="r g"></i><i class="r g2"></i><i class="r g"></i><i class="r g2"></i>',
  usage: '<i class="sb"></i><i class="u u1"></i><i class="u u2 g"></i><i class="u u3 g"></i><i class="cd"></i><i class="cu"></i>',
  view: '<i class="sd"></i><i class="pill"></i><i class="pa"></i><i class="l l1"></i><i class="s g2"></i><i class="l x x1 g"></i><i class="l x x2 g"></i><i class="l x x3 g"></i><i class="l x x4 g"></i>',
};
