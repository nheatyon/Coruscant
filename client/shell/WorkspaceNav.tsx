import { Link, useLocation } from 'react-router';
import { useCurrentContext } from '../lib/context.js';
export function WorkspaceNav({ staff = false }: { staff?: boolean }) {
  const { context } = useCurrentContext(); const location = useLocation();
  const role = context?.role === 'OWNER' ? 'Owner' : context?.role === 'REQUESTER' ? 'Requester' : context?.role === 'VIEWER' ? 'Viewer' : 'No workspace role';
  return <div className="workspace-bar"><div><span className="annotation">{staff ? 'STAFF / DEMONSTRATION' : context?.organization?.name}</span><span className="role-label">{staff ? 'Staff Admin' : role} · {context?.actor?.name}</span></div><nav aria-label={staff ? 'Staff workspace' : 'Customer workspace'}>{staff ? <Link to="/staff/requests" aria-current="page">Mission requests</Link> : <>{['requests', 'missions', 'results'].map((product, index) => <Link key={product} to={`/workspaces/${context?.organization?.id}/${product}`} aria-current={location.pathname.includes(`/${product}`) || (product === 'requests' && location.pathname.includes('/service-requests')) ? 'page' : undefined}>{['Requests', 'Mission Control', 'SatSuite'][index]}</Link>)}<Link to={`/workspaces?product=${location.pathname.includes('/missions') ? 'missions' : location.pathname.includes('/results') ? 'results' : 'requests'}`}>Choose workspace</Link></>}</nav></div>;
}
