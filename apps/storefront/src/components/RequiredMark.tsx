/** Visual required marker; hidden from assistive tech because the control's `required` already announces it. */
export default function RequiredMark() {
  return <span className="required-mark" aria-hidden="true">*</span>;
}
