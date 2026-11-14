// The ready-made browser build of mammoth has the same calls as the package's own types.
declare module 'mammoth/mammoth.browser' {
  import mammoth from 'mammoth';
  export default mammoth;
}
