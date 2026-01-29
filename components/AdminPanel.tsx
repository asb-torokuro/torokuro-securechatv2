
import React, { useEffect, useState } from 'react';
import { clearLogs, getUsers, subscribeToSystemLogs } from '../services/storageService';
import { SystemLog, User } from '../types';

interface AdminPanelProps {
  onLogout: () => void;
}

const AdminPanel: React.FC<AdminPanelProps> = ({ onLogout }) => {
  const [logs, setLogs] = useState<SystemLog[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [view, setView] = useState<'logs' | 'users'>('logs');
  const [expandedUserId, setExpandedUserId] = useState<string | null>(null);

  useEffect(() => {
    // Setup real-time listener for logs
    const unsubscribeLogs = subscribeToSystemLogs((updatedLogs) => {
      setLogs(updatedLogs);
    });

    // Fetch users function
    const fetchUsers = async () => {
      try {
        const fetchedUsers = await getUsers();
        setUsers(fetchedUsers);
      } catch (error) {
        console.error("Failed to fetch users", error);
      }
    };

    // Initial fetch
    fetchUsers();

    // Poll for users every 5 seconds (since we don't have a full collection listener for users in this component)
    const userInterval = setInterval(fetchUsers, 5000);

    return () => {
      unsubscribeLogs();
      clearInterval(userInterval);
    };
  }, []);

  const handleClearLogs = () => {
    if (confirm('Are you sure you want to delete all system logs?')) {
      clearLogs();
      // Since clearLogs in storageService doesn't actually delete from Firestore (per comments there),
      // we just clear the local state to give feedback.
      setLogs([]);
    }
  };

  const toggleHistory = (userId: string) => {
      if (expandedUserId === userId) {
          setExpandedUserId(null);
      } else {
          setExpandedUserId(userId);
      }
  };

  return (
    <div className="min-h-screen bg-gray-900 text-green-500 font-mono p-4">
      <div className="max-w-7xl mx-auto border border-green-800 p-6 shadow-[0_0_20px_rgba(34,197,94,0.1)] rounded bg-black">
        <header className="flex justify-between items-center mb-8 border-b border-green-900 pb-4">
          <div>
            <h1 className="text-3xl font-bold uppercase tracking-widest">System Admin</h1>
            <p className="text-xs text-green-700">Access Level: ROOT // Mode: Surveillance</p>
          </div>
          <div className="flex gap-4">
            <button 
              onClick={() => setView('logs')}
              className={`px-4 py-2 border ${view === 'logs' ? 'bg-green-900 text-black border-green-500' : 'border-green-800 hover:border-green-500'}`}
            >
              SYSTEM LOGS
            </button>
            <button 
              onClick={() => setView('users')}
              className={`px-4 py-2 border ${view === 'users' ? 'bg-green-900 text-black border-green-500' : 'border-green-800 hover:border-green-500'}`}
            >
              USER DATABASE
            </button>
            <button 
              onClick={onLogout}
              className="px-4 py-2 border border-red-800 text-red-500 hover:bg-red-900/20"
            >
              LOGOUT
            </button>
          </div>
        </header>

        {view === 'logs' && (
          <div>
            <div className="flex justify-between mb-4">
              <h2 className="text-xl">Encrypted Transmission Logs</h2>
              <button onClick={handleClearLogs} className="text-xs border border-red-900 text-red-700 px-2 hover:text-red-500">CLEAR BUFFER</button>
            </div>
            <div className="overflow-x-auto h-[600px] overflow-y-auto border border-green-900 scrollbar-thin scrollbar-thumb-green-900">
              <table className="w-full text-left text-sm">
                <thead className="bg-green-900/20 sticky top-0">
                  <tr>
                    <th className="p-2 border-b border-green-800 w-40">TIMESTAMP</th>
                    <th className="p-2 border-b border-green-800 w-32">LEVEL</th>
                    <th className="p-2 border-b border-green-800 w-48">EVENT</th>
                    <th className="p-2 border-b border-green-800">DETAILS</th>
                  </tr>
                </thead>
                <tbody>
                  {logs.map((log) => (
                    <tr key={log.id} className="hover:bg-green-900/10 transition-colors">
                      <td className="p-2 border-b border-green-900/50 text-green-600">{new Date(log.timestamp).toLocaleString()}</td>
                      <td className={`p-2 border-b border-green-900/50 uppercase font-bold ${
                        log.level === 'alert' ? 'text-red-500' : log.level === 'warning' ? 'text-yellow-500' : 'text-green-500'
                      }`}>
                        {log.level}
                      </td>
                      <td className="p-2 border-b border-green-900/50">{log.event}</td>
                      <td className="p-2 border-b border-green-900/50 font-mono text-xs opacity-80 break-all">{log.details}</td>
                    </tr>
                  ))}
                  {logs.length === 0 && (
                    <tr><td colSpan={4} className="p-8 text-center opacity-50">NO LOGS FOUND</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {view === 'users' && (
           <div>
             <h2 className="text-xl mb-4">Registered Identities</h2>
             <div className="grid gap-4">
                {users.length === 0 ? <p className="text-gray-500">No users found.</p> : users.map(u => (
                  <div key={u.id} className="border border-green-800 p-4 bg-green-900/5 hover:bg-green-900/10 transition-colors">
                    <div className="flex justify-between items-start">
                        <div>
                        <div className="font-bold text-lg flex items-center gap-2">
                            {u.username}
                            <span className="text-[10px] bg-green-900 text-green-300 px-1 rounded">{u.role}</span>
                        </div>
                        <div className="text-xs text-green-700 mb-2">ID: {u.id}</div>
                        
                        <div className="text-sm">
                            <span className="text-green-700 uppercase text-[10px] tracking-widest">Last Access:</span>
                            <div className="font-mono text-green-400">
                                {u.lastLogin ? new Date(u.lastLogin).toLocaleString() : 'NEVER'}
                            </div>
                        </div>
                        </div>
                        <div className="text-right flex flex-col items-end gap-2">
                            <div className="text-xs text-green-700 font-mono truncate max-w-[200px]">HASH: {u.passwordHash.substring(0, 10)}...</div>
                            <div className="text-xs text-green-700">Created: {new Date(u.createdAt).toLocaleDateString()}</div>
                            
                            <button 
                                onClick={() => toggleHistory(u.id)}
                                className="mt-2 text-xs border border-green-700 hover:bg-green-700 hover:text-black px-2 py-1 transition-colors uppercase tracking-wider"
                            >
                                {expandedUserId === u.id ? '[-] HIDE HISTORY' : '[+] VIEW HISTORY'}
                            </button>
                        </div>
                    </div>

                    {/* EXPANDED HISTORY */}
                    {expandedUserId === u.id && (
                        <div className="mt-4 pt-4 border-t border-green-900/50">
                            <h4 className="text-xs text-green-600 mb-2 font-bold tracking-widest">ACCESS LOGS ({u.loginHistory?.length || 0})</h4>
                            <div className="bg-black/50 p-2 h-32 overflow-y-auto font-mono text-xs border border-green-900/30">
                                {u.loginHistory && u.loginHistory.length > 0 ? (
                                    u.loginHistory.slice().reverse().map((ts, idx) => (
                                        <div key={idx} className="flex justify-between border-b border-green-900/20 py-1 last:border-0">
                                            <span className="text-green-500">LOGIN_SUCCESS</span>
                                            <span className="opacity-60">{new Date(ts).toLocaleString()}</span>
                                        </div>
                                    ))
                                ) : (
                                    <div className="text-gray-500 italic">No recorded history.</div>
                                )}
                            </div>
                        </div>
                    )}
                  </div>
                ))}
             </div>
           </div>
        )}
      </div>
    </div>
  );
};

export default AdminPanel;
