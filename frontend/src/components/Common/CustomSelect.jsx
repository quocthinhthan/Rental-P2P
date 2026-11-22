import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import './CustomSelect.css';

function normalizeOptions(options = []) {
  return options.map((opt) => {
    if (typeof opt === 'string' || typeof opt === 'number') {
      return { value: opt, label: String(opt), disabled: false };
    }
    return {
      value: opt.value,
      label: opt.label ?? String(opt.value ?? ''),
      disabled: Boolean(opt.disabled),
      icon: opt.icon,
    };
  });
}

function CustomSelect({
  value,
  onChange,
  options = [],
  placeholder = 'Chọn...',
  disabled = false,
  isInvalid = false,
  icon = null,
  variant = 'default',
  size = 'md',
  align = 'left',
  menuMinWidth,
  className = '',
  title,
  id,
  ariaLabel,
  onBlur,
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const [menuStyle, setMenuStyle] = useState(null);
  const [isAbove, setIsAbove] = useState(false);

  const triggerRef = useRef(null);
  const menuRef = useRef(null);

  const normalizedOptions = useMemo(() => normalizeOptions(options), [options]);

  const selectedIndex = useMemo(
    () => normalizedOptions.findIndex((opt) => String(opt.value) === String(value ?? '')),
    [normalizedOptions, value]
  );

  const selectedOption = selectedIndex >= 0 ? normalizedOptions[selectedIndex] : null;
  const displayLabel = selectedOption ? selectedOption.label : placeholder;
  const isShowingPlaceholder = !selectedOption || String(selectedOption.value) === '';

  const updatePosition = useCallback(() => {
    const triggerEl = triggerRef.current;
    if (!triggerEl) return;

    const rect = triggerEl.getBoundingClientRect();
    const viewportHeight = window.innerHeight;
    const viewportWidth = window.innerWidth;
    const estimatedMenuHeight = Math.min(270, Math.max(52, normalizedOptions.length * 40 + 14));
    const spaceBelow = viewportHeight - rect.bottom - 12;
    const spaceAbove = rect.top - 12;
    const openAbove = spaceBelow < estimatedMenuHeight && spaceAbove > spaceBelow;

    const minWidth = Math.max(rect.width, menuMinWidth || 0);
    const width = Math.min(minWidth, viewportWidth - 20);

    let left = align === 'right' ? rect.right - width : rect.left;
    if (left + width > viewportWidth - 10) {
      left = viewportWidth - width - 10;
    }
    if (left < 10) {
      left = 10;
    }

    const maxHeight = Math.max(
      120,
      Math.min(270, openAbove ? spaceAbove - 6 : spaceBelow - 6)
    );

    const style = {
      left: `${Math.round(left)}px`,
      width: `${Math.round(width)}px`,
      maxHeight: `${Math.round(maxHeight)}px`,
    };

    if (openAbove) {
      style.bottom = `${Math.round(viewportHeight - rect.top + 6)}px`;
    } else {
      style.top = `${Math.round(rect.bottom + 6)}px`;
    }

    setIsAbove(openAbove);
    setMenuStyle(style);
  }, [align, menuMinWidth, normalizedOptions.length]);

  const closeMenu = useCallback(() => {
    setIsOpen(false);
    setHighlightedIndex(-1);
    if (onBlur) onBlur();
  }, [onBlur]);

  const openMenu = useCallback(() => {
    if (disabled) return;
    updatePosition();
    setHighlightedIndex(selectedIndex >= 0 ? selectedIndex : 0);
    setIsOpen(true);
  }, [disabled, selectedIndex, updatePosition]);

  const handleToggle = () => {
    if (disabled) return;
    if (isOpen) {
      closeMenu();
    } else {
      openMenu();
    }
  };

  const handleSelect = (opt) => {
    if (opt.disabled) return;
    if (onChange) {
      onChange(opt.value);
    }
    closeMenu();
    triggerRef.current?.focus();
  };

  useEffect(() => {
    if (!isOpen) return undefined;

    updatePosition();

    const handlePointerDown = (event) => {
      const target = event.target;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) {
        return;
      }
      closeMenu();
    };

    const handleScroll = (event) => {
      if (menuRef.current && menuRef.current.contains(event.target)) {
        return;
      }
      updatePosition();
    };

    const handleResize = () => updatePosition();

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('touchstart', handlePointerDown, { passive: true });
    window.addEventListener('scroll', handleScroll, true);
    window.addEventListener('resize', handleResize);

    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('touchstart', handlePointerDown);
      window.removeEventListener('scroll', handleScroll, true);
      window.removeEventListener('resize', handleResize);
    };
  }, [isOpen, closeMenu, updatePosition]);

  useEffect(() => {
    if (disabled && isOpen) {
      setIsOpen(false);
    }
  }, [disabled, isOpen]);

  const findNextEnabledIndex = (startIndex, direction) => {
    if (normalizedOptions.length === 0) return -1;
    let idx = startIndex;
    for (let step = 0; step < normalizedOptions.length; step += 1) {
      idx = (idx + direction + normalizedOptions.length) % normalizedOptions.length;
      if (!normalizedOptions[idx].disabled) return idx;
    }
    return -1;
  };

  const handleKeyDown = (event) => {
    if (disabled) return;

    if (!isOpen) {
      if (['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(event.key)) {
        event.preventDefault();
        openMenu();
      }
      return;
    }

    switch (event.key) {
      case 'Escape':
        event.preventDefault();
        closeMenu();
        break;
      case 'ArrowDown':
        event.preventDefault();
        setHighlightedIndex((prev) => findNextEnabledIndex(prev < 0 ? -1 : prev, 1));
        break;
      case 'ArrowUp':
        event.preventDefault();
        setHighlightedIndex((prev) =>
          findNextEnabledIndex(prev < 0 ? normalizedOptions.length : prev, -1)
        );
        break;
      case 'Home':
        event.preventDefault();
        setHighlightedIndex(findNextEnabledIndex(-1, 1));
        break;
      case 'End':
        event.preventDefault();
        setHighlightedIndex(findNextEnabledIndex(normalizedOptions.length, -1));
        break;
      case 'Enter':
      case ' ':
        event.preventDefault();
        if (highlightedIndex >= 0 && normalizedOptions[highlightedIndex]) {
          handleSelect(normalizedOptions[highlightedIndex]);
        } else {
          closeMenu();
        }
        break;
      case 'Tab':
        closeMenu();
        break;
      default:
        break;
    }
  };

  const wrapperClasses = [
    'cs-wrapper',
    `cs-wrapper--${variant}`,
    size === 'sm' ? 'cs-wrapper--sm' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  const triggerClasses = [
    'cs-trigger',
    isOpen ? 'is-open' : '',
    isInvalid ? 'is-invalid' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const menuPortal =
    isOpen && menuStyle
      ? createPortal(
          <div
            ref={menuRef}
            className={`cs-menu ${isAbove ? 'is-above' : ''}`}
            style={menuStyle}
            role="listbox"
          >
            {normalizedOptions.length === 0 ? (
              <div className="cs-empty">Không có lựa chọn</div>
            ) : (
              normalizedOptions.map((opt, idx) => {
                const isSelected = idx === selectedIndex;
                const isHighlighted = idx === highlightedIndex;
                return (
                  <button
                    key={`${String(opt.value)}-${idx}`}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    disabled={opt.disabled}
                    className={[
                      'cs-option',
                      isSelected ? 'is-selected' : '',
                      isHighlighted ? 'is-highlighted' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    onMouseEnter={() => setHighlightedIndex(idx)}
                    onClick={() => handleSelect(opt)}
                  >
                    <span className="cs-option-text">
                      {opt.icon && <i className={opt.icon} aria-hidden="true" />}
                      <span>{opt.label}</span>
                    </span>
                    {isSelected && (
                      <i className="fas fa-check cs-option-check" aria-hidden="true" />
                    )}
                  </button>
                );
              })
            )}
          </div>,
          document.body
        )
      : null;

  return (
    <div className={wrapperClasses}>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        className={triggerClasses}
        disabled={disabled}
        title={title}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        onClick={handleToggle}
        onKeyDown={handleKeyDown}
      >
        <span className="cs-trigger-main">
          {icon &&
            (typeof icon === 'string' ? (
              <i className={`${icon} cs-trigger-icon`} aria-hidden="true" />
            ) : (
              <span className="cs-trigger-icon">{icon}</span>
            ))}
          <span
            className={`cs-trigger-label ${
              isShowingPlaceholder ? 'is-placeholder' : ''
            }`}
          >
            {displayLabel}
          </span>
        </span>
        <i className="fas fa-chevron-down cs-chevron" aria-hidden="true" />
      </button>
      {menuPortal}
    </div>
  );
}

export default CustomSelect;
