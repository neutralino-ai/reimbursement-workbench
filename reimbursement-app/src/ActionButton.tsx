import {useId,type ButtonHTMLAttributes} from 'react';
import './action-button.css';

type Props=Omit<ButtonHTMLAttributes<HTMLButtonElement>,'disabled'> & {reason?:string};
/** The same reason controls disabling and its visible, accessible explanation. */
export default function ActionButton({reason='',children,...props}:Props){
  const id=useId();
  const description=[props['aria-describedby'],reason?id:undefined].filter(Boolean).join(' ')||undefined;
  return <span className="action-with-reason"><button type="button" {...props} disabled={!!reason} aria-describedby={description} title={reason||props.title}>{children}</button>{reason&&<small id={id} className="action-disabled-reason">{reason}</small>}</span>;
}
