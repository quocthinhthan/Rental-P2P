import React from 'react';
import { Navigate, Outlet } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';


function ProtectedRoute({ requireAdmin = false, allowedRoles = null }) {
  const { isLoggedIn, user, loading } = useAuth();

  if (loading) {
    // Nếu đang trong quá trình kiểm tra token (tải lại trang)
    // Hiển thị spinner thay vì trang
    return <div className="container py-5 text-center">Loading...</div>;
  }

  if (!isLoggedIn) {
    // Nếu không đăng nhập, chuyển hướng (Navigate) về trang login
    return <Navigate to="/login" replace />;
  }

  if (requireAdmin && user?.role !== 'admin') {
    return <Navigate to="/" replace />;
  }

  if (Array.isArray(allowedRoles) && allowedRoles.length > 0 && !allowedRoles.includes(user?.role)) {
    return <Navigate to="/" replace />;
  }

  // Nếu đủ quyền truy cập, hiển thị component con
  return <Outlet />;
}

export function AdminRoute() {
  return <ProtectedRoute requireAdmin />;
}

export default ProtectedRoute;