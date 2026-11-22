import React, { useState, useEffect, useMemo } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import apiService from '../../services/api';
import CustomSelect from '../Common/CustomSelect';
// Import file layout.css
import '../../styles/layout.css';

function Header() {
  const { isLoggedIn, user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('');
  const [categories, setCategories] = useState([]);
  const [rentalBadgeCount, setRentalBadgeCount] = useState(0);

  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [isMobileCatOpen, setIsMobileCatOpen] = useState(false);
  const [isMobileSupportOpen, setIsMobileSupportOpen] = useState(false);

  const categoryOptions = useMemo(
    () => [
      { value: '', label: 'Tất cả danh mục' },
      ...categories.map((cat) => ({ value: cat, label: cat })),
    ],
    [categories]
  );

  // Tự động đóng menu mobile & dropdown khi chuyển trang
  useEffect(() => {
    setIsMobileMenuOpen(false);
    setIsMobileCatOpen(false);
    setIsMobileSupportOpen(false);
  }, [location.pathname, location.search]);

  useEffect(() => {
    const fetchCategories = async () => {
      try {
        const response = await apiService.getCategories();
        setCategories(response.data);
      } catch (err) {
        console.error('Lỗi khi tải danh mục:', err);
      }
    };
    fetchCategories();
  }, []);

  useEffect(() => {
    if (!isLoggedIn) {
      setRentalBadgeCount(0);
      return;
    }

    const activeRentalStatuses = new Set([
      'pending_payment',
      'pending_confirmation',
      'confirmed',
      'in_progress',
      'disputed',
    ]);

    const countActiveRentals = (rentals = []) => (
      rentals.filter((rental) => activeRentalStatuses.has(rental?.status)).length
    );

    const fetchRentalBadgeCount = async () => {
      try {
        const response = await apiService.getMyRentals({ skipGlobalLoading: true });
        const asRenterCount = countActiveRentals(response.data?.asRenter);
        const asOwnerCount = countActiveRentals(response.data?.asOwner);
        setRentalBadgeCount(asRenterCount + asOwnerCount);
      } catch (err) {
        console.error('Lỗi khi tải số lượng đơn thuê:', err);
        setRentalBadgeCount(0);
      }
    };

    fetchRentalBadgeCount();
  }, [isLoggedIn, user?._id, location.pathname, location.search]);

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  const handleSearch = (e) => {
    e.preventDefault();
    const params = new URLSearchParams();
    if (searchQuery.trim()) params.append('search', searchQuery.trim());
    if (selectedCategory) params.append('category', selectedCategory);
    const queryString = params.toString();
    navigate(`/shop${queryString ? `?${queryString}` : ''}`);
  };

  const handleOpenLocationPicker = () => {
    const itemFilters = {
      search: searchQuery.trim(),
      category: selectedCategory,
    };

    window.dispatchEvent(new CustomEvent('rentalp2p:open-location-picker', {
      detail: {
        itemFilters,
        preferCurrentLocation: true,
        onConfirm: ({ location, radius }) => {
          const params = new URLSearchParams();
          if (itemFilters.search) params.append('search', itemFilters.search);
          if (itemFilters.category) params.append('category', itemFilters.category);
          params.append('lat', location.lat);
          params.append('lng', location.lng);
          if (radius) params.append('radius', radius);
          navigate(`/shop?${params.toString()}`);
        },
      },
    }));
  };

  return (
    <>
      {/* Search Header Start */}
      <div className={`container-fluid px-5 py-3 d-none d-lg-block bg-white shadow-sm search-header-wrapper ${location.pathname.startsWith('/admin') ? 'mb-3' : ''}`}>
        <div className="row gx-0 align-items-center">

          {/* Logo */}
          {/* <div className="col-lg-3 col-xl-3 text-start">
            <Link to="/" className="navbar-brand p-0 text-decoration-none d-inline-block">
              <h1 className="display-6 text-primary m-0 fw-bold d-flex align-items-center">
                <i className="fas fa-sync-alt text-secondary me-2 brand-icon-spin"></i>RentalP2P
              </h1>
            </Link>
          </div> */}
          
          {/* Logo */}
          <div className="col-lg-3 col-xl-3 text-start">
            <Link to="/" className="navbar-brand p-0 text-decoration-none d-inline-block">
              <img src="/logo-brand-2.png" alt="RentalP2P Logo" style={{ height: '50px', width: 'auto', objectFit: 'contain' }} />
            </Link>
          </div>

          {/* Thanh Tìm Kiếm Hiện Đại */}
          <div className="col-lg-6 col-xl-6 text-center">
            <div className="header-search-cluster">
              <form className="d-flex custom-search-bar" onSubmit={handleSearch}>
                <span className="search-field-icon">
                  <i className="fas fa-search"></i>
                </span>
                <input
                  className="form-control border-0 bg-transparent py-2 px-3 shadow-none search-main-input"
                  type="text"
                  placeholder="Tìm kiếm sản phẩm..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />

                <div className="search-divider"></div>

                {/* Shared CustomSelect trong Search Bar */}
                <div className="d-flex align-items-center">
                  <CustomSelect
                    variant="pill"
                    align="right"
                    menuMinWidth={210}
                    value={selectedCategory}
                    onChange={(val) => setSelectedCategory(val)}
                    options={categoryOptions}
                    placeholder="Tất cả"
                    ariaLabel="Chọn danh mục tìm kiếm"
                  />
                </div>

                <button type="submit" className="btn btn-primary search-btn px-3 ms-2">
                  <i className="fas fa-search"></i>
                </button>
              </form>

              <button
                type="button"
                className="btn header-location-btn"
                onClick={handleOpenLocationPicker}
              >
                <span className="header-location-icon">
                  <i className="fas fa-location-arrow"></i>
                </span>
                <span className="header-location-copy">
                  <span>Tìm đồ quanh đây</span>
                  <small>Chọn vị trí trên bản đồ</small>
                </span>
                <i className="fas fa-chevron-right header-location-arrow"></i>
              </button>
            </div>
          </div>

          {/* Favorites & Cart & User Header Actions */}
          <div className="col-lg-3 col-xl-3 text-end d-flex align-items-center justify-content-end gap-2 header-actions-container">
            {isLoggedIn && (
              <>
                {/* Nút yêu thích nhanh */}
                <Link to="/favorites" className="text-decoration-none fav-link header-action-btn d-inline-flex align-items-center" title="Sản phẩm yêu thích">
                  <div className="position-relative fav-icon-wrapper action-icon-circle d-flex justify-content-center align-items-center rounded-circle border">
                    <i className="fas fa-heart text-danger fs-5"></i>
                  </div>
                  <span className="action-text">Yêu thích</span>
                </Link>

                <div className="header-divider d-none d-xl-block"></div>

                {/* Đơn thuê */}
                <Link to="/my-rentals" className="text-decoration-none cart-link header-action-btn d-inline-flex align-items-center" title="Quản lý đơn thuê">
                  <div className="position-relative cart-icon-wrapper action-icon-circle d-flex justify-content-center align-items-center rounded-circle border">
                    <i className="fas fa-shopping-cart text-primary fs-5"></i>
                    {rentalBadgeCount > 0 && (
                      <span className="position-absolute top-0 start-100 translate-middle badge rounded-pill bg-danger border border-white">
                        {rentalBadgeCount}
                      </span>
                    )}
                  </div>
                  <span className="action-text">Đơn thuê</span>
                </Link>

                <div className="header-divider d-none d-xl-block"></div>
              </>
            )}

            {/* Tài khoản Người dùng */}
            <div className="dropdown custom-dropdown align-self-center">
              <button
                type="button"
                className="btn text-decoration-none d-inline-flex align-items-center border-0 bg-transparent p-0 user-dropdown-trigger header-action-btn"
                data-bs-toggle="dropdown"
                aria-expanded="false"
              >
                <div className="position-relative user-icon-wrapper action-icon-circle d-flex justify-content-center align-items-center rounded-circle border overflow-hidden">
                  {isLoggedIn && user?.avatarUrl ? (
                    <img
                      src={user.avatarUrl}
                      alt={user.fullName}
                      style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                    />
                  ) : (
                    <i className="fas fa-user text-primary fs-5"></i>
                  )}
                </div>
                <span className="action-text-permanent d-inline-flex align-items-center">
                  {isLoggedIn && user ? user.fullName.split(' ').pop() : 'Tài khoản'}
                  <i className="fas fa-chevron-down ms-1 dropdown-arrow-icon" style={{ fontSize: '9px', color: '#94a3b8' }}></i>
                </span>
              </button>

              <div className="dropdown-menu dropdown-menu-end custom-dropdown-menu mt-2">
                {isLoggedIn && user ? (
                  <>
                    <div className="dropdown-header dropdown-user-header">
                      <div className="dropdown-user-avatar">
                        {user.avatarUrl ? (
                          <img src={user.avatarUrl} alt={user.fullName} />
                        ) : (
                          <i className="fas fa-user"></i>
                        )}
                      </div>
                      <div className="min-w-0 flex-grow-1">
                        <p className="mb-0 text-muted fs-7">Xin chào,</p>
                        <div className="d-flex align-items-center gap-2">
                          <h6 className="mb-0 text-dark fw-bold text-truncate">{user.fullName}</h6>
                          {user.role === 'admin' && (
                            <span className="dropdown-admin-badge">Admin</span>
                          )}
                        </div>
                      </div>
                    </div>

                    <hr className="dropdown-divider mx-3 my-2" />
                    <div className="dropdown-section-label">Hoạt động thuê &amp; cho thuê</div>
                    <Link to="/my-rentals" className="dropdown-item custom-dropdown-item">
                      <i className="fas fa-clipboard-list me-2 item-icon text-primary"></i>
                      <span className="flex-grow-1">Quản lý đơn thuê</span>
                      {rentalBadgeCount > 0 && (
                        <span className="badge rounded-pill bg-danger ms-2">{rentalBadgeCount}</span>
                      )}
                    </Link>
                    <Link to="/post-item" className="dropdown-item custom-dropdown-item">
                      <i className="fas fa-plus-circle me-2 item-icon text-warning"></i>
                      <span>Đăng đồ cho thuê</span>
                    </Link>
                    <Link to="/financial-dashboard" className="dropdown-item custom-dropdown-item">
                      <i className="fas fa-wallet me-2 item-icon text-success"></i>
                      <span>Tài chính &amp; Doanh thu</span>
                    </Link>

                    <hr className="dropdown-divider mx-3 my-2" />
                    <div className="dropdown-section-label">Cá nhân</div>
                    <Link to="/favorites" className="dropdown-item custom-dropdown-item">
                      <i className="fas fa-heart me-2 item-icon text-danger"></i>
                      <span>Sản phẩm yêu thích</span>
                    </Link>
                    <Link to="/account" className="dropdown-item custom-dropdown-item">
                      <i className="fas fa-user-cog me-2 item-icon"></i>
                      <span>Tài khoản của tôi</span>
                    </Link>

                    {user.role === 'admin' && (
                      <>
                        <hr className="dropdown-divider mx-3 my-2" />
                        <div className="dropdown-section-label">Quản trị hệ thống</div>
                        <Link to="/admin/dashboard" className="dropdown-item custom-dropdown-item">
                          <i className="fas fa-chart-line me-2 item-icon"></i>
                          <span>Tổng quan admin</span>
                        </Link>
                        <Link to="/admin/users" className="dropdown-item custom-dropdown-item">
                          <i className="fas fa-users me-2 item-icon"></i>
                          <span>Quản lý người dùng</span>
                        </Link>
                        <Link to="/admin/items" className="dropdown-item custom-dropdown-item">
                          <i className="fas fa-boxes me-2 item-icon"></i>
                          <span>Quản lý sản phẩm</span>
                        </Link>
                        <Link to="/admin/item-reports" className="dropdown-item custom-dropdown-item">
                          <i className="fas fa-flag me-2 item-icon"></i>
                          <span>Báo cáo sản phẩm</span>
                        </Link>
                        <Link to="/admin/disputes" className="dropdown-item custom-dropdown-item">
                          <i className="fas fa-gavel me-2 item-icon"></i>
                          <span>Xử lý tranh chấp</span>
                        </Link>
                      </>
                    )}

                    <hr className="dropdown-divider mx-3 my-2" />
                    <button onClick={handleLogout} className="dropdown-item custom-dropdown-item text-danger logout-btn">
                      <i className="fas fa-sign-out-alt me-2 item-icon"></i>
                      <span>Đăng xuất</span>
                    </button>
                  </>
                ) : (
                  <>
                    <div className="dropdown-section-label">Tài khoản</div>
                    <Link to="/login" className="dropdown-item custom-dropdown-item">
                      <i className="fas fa-sign-in-alt me-2 item-icon"></i>Đăng nhập
                    </Link>
                    <Link to="/register" className="dropdown-item custom-dropdown-item">
                      <i className="fas fa-user-plus me-2 item-icon"></i>Đăng ký
                    </Link>
                  </>
                )}
              </div>
            </div>
          </div>

        </div>
      </div>
      {/* Search Header End */}

      {/* Navbar Start */}
      <div className="container-fluid nav-bar p-0">
        <div className="row gx-0 bg-primary px-3 px-lg-5 align-items-center">

          {/* Cột Danh Mục (Categories) */}
          <div className="col-lg-3 d-none d-lg-block">
            <nav className="navbar navbar-light position-relative p-0" style={{ width: '250px' }}>
              <button
                className="navbar-toggler border-0 w-100 text-start d-flex align-items-center rounded-0 p-3"
                type="button"
                data-bs-toggle="collapse"
                data-bs-target="#allCat"
                style={{ backgroundColor: 'rgba(0, 0, 0, 0.05)' }} /* Màu nền làm nổi bật khối danh mục như template */
              >
                <h4 className="m-0 text-dark fw-bold" style={{ fontSize: '1.2rem' }}>
                  <i className="fa fa-bars me-3"></i>Danh mục
                </h4>
              </button>

              {/* Danh sách thả xuống của Danh Mục */}
              <div className="collapse navbar-collapse rounded-bottom position-absolute w-100 bg-white shadow-lg custom-category-dropdown" id="allCat" style={{ top: '100%', left: 0 }}>
                <div className="navbar-nav py-0 w-100">
                  <div className="categories-list w-100">
                    {categories.length > 0 ? (
                      categories.map((cat) => (
                        <Link
                          key={cat}
                          to={`/shop?category=${encodeURIComponent(cat)}`}
                          className="category-item d-flex align-items-center justify-content-between text-decoration-none"
                        >
                          <div className="d-flex align-items-center">
                            <div className="category-icon-box me-3">
                              <i className="fas fa-th-large"></i> {/* Bạn có thể thay icon tùy ý */}
                            </div>
                            <span className="category-name">{cat}</span>
                          </div>
                          <i className="fas fa-chevron-right arrow-icon"></i>
                        </Link>
                      ))
                    ) : (
                      <div className="p-4 text-center text-muted">
                        <i className="fas fa-box-open d-block mb-2 fs-3"></i>
                        <small>Chưa có danh mục</small>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </nav>
          </div>

          {/* Cột Menu Chính */}
          <div className="col-12 col-lg-9">
            <nav className="navbar navbar-expand-lg navbar-dark bg-primary py-2 py-lg-0 px-0">
              <Link to="/" className="navbar-brand d-flex d-lg-none align-items-center m-0 mobile-brand-logo">
                <i className="fas fa-sync-alt text-white me-2"></i>
                <span>RentalP2P</span>
              </Link>

              {/* Mobile Quick Actions (Login / Rentals / Account + Menu Toggle) */}
              <div className="d-flex d-lg-none align-items-center gap-2 ms-auto mobile-header-actions">
                {isLoggedIn && user ? (
                  <>
                    <Link
                      to="/favorites"
                      className="mobile-icon-btn"
                      title="Sản phẩm yêu thích"
                      aria-label="Sản phẩm yêu thích"
                    >
                      <i className="fas fa-heart"></i>
                    </Link>
                    <Link
                      to="/my-rentals"
                      className="mobile-icon-btn position-relative"
                      title="Quản lý đơn thuê"
                      aria-label="Quản lý đơn thuê"
                    >
                      <i className="fas fa-shopping-cart"></i>
                      {rentalBadgeCount > 0 && (
                        <span className="mobile-icon-badge">{rentalBadgeCount}</span>
                      )}
                    </Link>
                    <Link
                      to="/account"
                      className="mobile-avatar-btn"
                      title={user.fullName || 'Tài khoản'}
                      aria-label="Tài khoản của tôi"
                    >
                      {user.avatarUrl ? (
                        <img src={user.avatarUrl} alt={user.fullName} />
                      ) : (
                        <i className="fas fa-user"></i>
                      )}
                    </Link>
                  </>
                ) : (
                  <Link to="/login" className="btn mobile-login-pill">
                    <i className="fas fa-sign-in-alt me-1"></i>Đăng nhập
                  </Link>
                )}

                <button
                  className="navbar-toggler mobile-menu-toggle"
                  type="button"
                  onClick={() => setIsMobileMenuOpen((prev) => !prev)}
                  aria-controls="navbarCollapse"
                  aria-expanded={isMobileMenuOpen}
                  aria-label="Mở menu điều hướng"
                >
                  <span className={`fas ${isMobileMenuOpen ? 'fa-times' : 'fa-bars'} text-white`}></span>
                </button>
              </div>

              <div className={`collapse navbar-collapse ${isMobileMenuOpen ? 'show' : ''}`} id="navbarCollapse">
                {/* Dùng ms-auto để căn phải như template */}
                <div className="navbar-nav ms-auto py-0 font-weight-bold">
                  <Link to="/" className={`nav-item nav-link ${location.pathname === '/' ? 'active' : ''}`}>Trang chủ</Link>
                  <Link to="/shop" className={`nav-item nav-link ${location.pathname.startsWith('/shop') ? 'active' : ''}`}>Cửa hàng</Link>
                  <Link to="/about" className={`nav-item nav-link ${location.pathname === '/about' ? 'active' : ''}`}>Về chúng tôi</Link>

                  {/* Dropdown cho các trang phụ */}
                  <div className={`nav-item dropdown ${isMobileSupportOpen ? 'show' : ''}`}>
                    <span
                      className={`nav-link dropdown-toggle ${['/help', '/faq'].some(p => location.pathname.startsWith(p)) ? 'active' : ''}`}
                      role="button"
                      aria-expanded={isMobileSupportOpen}
                      onClick={() => setIsMobileSupportOpen((prev) => !prev)}
                      style={{ cursor: 'pointer' }}
                    >
                      Hỗ trợ
                    </span>
                    <div className={`dropdown-menu m-0 ${isMobileSupportOpen ? 'show' : ''}`}>
                      <Link to="/help" className={`dropdown-item ${location.pathname === '/help' ? 'active' : ''}`}>
                        <i className="fas fa-life-ring me-2" />Trung tâm trợ giúp
                      </Link>
                      <Link to="/faq" className={`dropdown-item ${location.pathname === '/faq' ? 'active' : ''}`}>
                        <i className="fas fa-comments me-2" />Câu hỏi thường gặp
                      </Link>
                    </div>
                  </div>

                  <Link to="/contact" className={`nav-item nav-link me-lg-2 ${location.pathname === '/contact' ? 'active' : ''}`}>Liên hệ</Link>
                </div>

                {/* Mobile-only: Danh mục sản phẩm */}
                {categories.length > 0 && (
                  <div className="d-lg-none mobile-nav-section">
                    <button
                      type="button"
                      className="mobile-cat-toggle"
                      onClick={() => setIsMobileCatOpen((prev) => !prev)}
                      aria-expanded={isMobileCatOpen}
                    >
                      <span><i className="fas fa-th-large me-2"></i>Danh mục sản phẩm</span>
                      <i className={`fas fa-chevron-down transition-icon ${isMobileCatOpen ? 'rotate-180' : ''}`}></i>
                    </button>
                    {isMobileCatOpen && (
                      <div className="mobile-cat-chips">
                        <Link to="/shop" className="mobile-cat-chip">Tất cả</Link>
                        {categories.map((cat) => (
                          <Link
                            key={cat}
                            to={`/shop?category=${encodeURIComponent(cat)}`}
                            className="mobile-cat-chip"
                          >
                            {cat}
                          </Link>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* Mobile-only: Tài khoản & Đăng nhập / Đăng ký */}
                <div className="d-lg-none mobile-auth-section">
                  {isLoggedIn && user ? (
                    <div className="mobile-auth-card">
                      <div className="mobile-auth-user">
                        <div className="mobile-auth-user-avatar">
                          {user.avatarUrl ? (
                            <img src={user.avatarUrl} alt={user.fullName} />
                          ) : (
                            <i className="fas fa-user"></i>
                          )}
                        </div>
                        <div className="min-w-0">
                          <small>Xin chào,</small>
                          <div className="mobile-auth-user-name text-truncate">{user.fullName}</div>
                        </div>
                      </div>

                      <div className="mobile-account-group">
                        <div className="mobile-admin-label">Hoạt động thuê &amp; cho thuê</div>
                        <div className="mobile-account-grid">
                          <Link to="/my-rentals" className="mobile-account-link">
                            <i className="fas fa-clipboard-list"></i>
                            <span>Đơn thuê</span>
                            {rentalBadgeCount > 0 && (
                              <span className="badge rounded-pill bg-danger ms-auto">{rentalBadgeCount}</span>
                            )}
                          </Link>
                          <Link to="/post-item" className="mobile-account-link">
                            <i className="fas fa-plus-circle"></i>
                            <span>Đăng đồ</span>
                          </Link>
                          <Link to="/financial-dashboard" className="mobile-account-link mobile-account-link--wide">
                            <i className="fas fa-wallet"></i>
                            <span>Tài chính &amp; Doanh thu</span>
                          </Link>
                        </div>
                      </div>

                      <div className="mobile-admin-links">
                        <div className="mobile-admin-label">Cá nhân</div>
                        <div className="mobile-account-grid">
                          <Link to="/favorites" className="mobile-account-link">
                            <i className="fas fa-heart"></i>
                            <span>Yêu thích</span>
                          </Link>
                          <Link to="/account" className="mobile-account-link">
                            <i className="fas fa-user-cog"></i>
                            <span>Tài khoản</span>
                          </Link>
                        </div>
                      </div>

                      {user.role === 'admin' && (
                        <div className="mobile-admin-links">
                          <div className="mobile-admin-label">Quản trị hệ thống</div>
                          <div className="mobile-account-grid">
                            <Link to="/admin/dashboard" className="mobile-account-link">
                              <i className="fas fa-chart-line"></i>
                              <span>Tổng quan</span>
                            </Link>
                            <Link to="/admin/users" className="mobile-account-link">
                              <i className="fas fa-users"></i>
                              <span>Người dùng</span>
                            </Link>
                            <Link to="/admin/items" className="mobile-account-link">
                              <i className="fas fa-boxes"></i>
                              <span>Sản phẩm</span>
                            </Link>
                            <Link to="/admin/item-reports" className="mobile-account-link">
                              <i className="fas fa-flag"></i>
                              <span>Báo cáo</span>
                            </Link>
                            <Link to="/admin/disputes" className="mobile-account-link mobile-account-link--wide">
                              <i className="fas fa-gavel"></i>
                              <span>Xử lý tranh chấp</span>
                            </Link>
                          </div>
                        </div>
                      )}

                      <div className="mobile-admin-links">
                        <button type="button" onClick={handleLogout} className="mobile-account-link mobile-logout-link">
                          <i className="fas fa-sign-out-alt"></i>
                          <span>Đăng xuất</span>
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="mobile-guest-actions">
                      <Link to="/login" className="btn mobile-guest-login-btn">
                        <i className="fas fa-sign-in-alt me-2"></i>Đăng nhập
                      </Link>
                      <Link to="/register" className="btn mobile-guest-register-btn">
                        <i className="fas fa-user-plus me-2"></i>Đăng ký
                      </Link>
                    </div>
                  )}
                </div>

                {/* Nút Hotline CSKH hỗ trợ bên phải */}
                <a href="tel:+84364123957" className="btn nav-hotline-btn text-white rounded-pill mb-3 mb-lg-0 fw-bold d-inline-flex align-items-center" title="Hỗ trợ chăm sóc khách hàng 24/7">
                  <span className="hotline-icon-wrapper me-2">
                    <i className="fas fa-headset animate-pulse-gentle"></i>
                  </span>
                  <div className="text-start lh-1 hotline-content">
                    <small className="hotline-subtext d-block">
                      <span className="status-dot-active me-1"></span>CSKH HỖ TRỢ 24/7
                    </small>
                    <span className="hotline-number">+84 364 123 957</span>
                  </div>
                </a>
              </div>
            </nav>
          </div>

        </div>
      </div>
      {/* Navbar End */}

      {/* Mobile Search & Nearby Bar (hidden on desktop >= 992px) */}
      <div className="container-fluid d-lg-none mobile-search-strip bg-white border-bottom shadow-sm py-2 px-3">
        <div className="mobile-search-cluster">
          <form className="mobile-search-form" onSubmit={handleSearch}>
            <i className="fas fa-search mobile-search-icon"></i>
            <input
              type="text"
              className="form-control border-0 bg-transparent shadow-none mobile-search-input"
              placeholder="Tìm sản phẩm cho thuê..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            <button type="submit" className="btn btn-primary mobile-search-submit" aria-label="Tìm kiếm">
              <i className="fas fa-search"></i>
            </button>
          </form>
          <button
            type="button"
            className="btn mobile-location-btn"
            onClick={handleOpenLocationPicker}
            title="Tìm đồ quanh đây"
            aria-label="Tìm đồ quanh đây"
          >
            <i className="fas fa-location-arrow"></i>
            <span className="d-none d-sm-inline">Quanh đây</span>
          </button>
        </div>
      </div>
    </>
  );
}

export default Header;
